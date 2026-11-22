// Workflow Dependency Graph UI Controller
// Injects "Graph" tab into [data-testid="workflow-view-tabs"]
// Renders horizontal DAG canvas adhering 100% to viaSocket's native Material-UI design principles

import type { FlowGraphConnection, FlowGraphData, FlowGraphNode, FlowGraphPort } from '../shared/messages'
import type { PageBridge } from './page-bridge'

const STYLE_ID = 'vs-dependency-graph-styles'
const TAB_BUTTON_TESTID = 'workflow-graph-view-tab'
const OVERLAY_ID = 'vs-dependency-graph-overlay'

const JS_ICON_URL = 'https://stuff.thingsofbrand.com/viasocket.com/images/img6_js-code-new-bg.svg'
const WEBHOOK_ICON_URL = 'https://stuff.thingsofbrand.com/viasocket.com/images/imge_Webhook-bg.svg'

const CSS = `
.vs-graph-tab-wrapper {
  display: inline-flex;
  align-items: center;
  height: 100%;
}

/* Material-UI Navbar Graph View Tab (100% match with Flow, Published, Log in light and dark mode) */
[data-testid="${TAB_BUTTON_TESTID}"] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  position: relative !important;
  box-sizing: border-box !important;
  outline: 0px !important;
  margin: 0px !important;
  cursor: pointer !important;
  user-select: none !important;
  vertical-align: middle !important;
  appearance: none !important;
  text-decoration: none !important;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  line-height: 22.75px !important;
  letter-spacing: 0px !important;
  text-transform: none !important;
  padding: 4px 14px !important;
  height: 31px !important;
  border: 0px !important;
  border-radius: 0px 4px 4px 0px !important;
  background-color: transparent !important;
  color: rgb(63, 63, 58) !important;
  transition: background-color 300ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 300ms cubic-bezier(0.4, 0, 0.2, 1), color 300ms cubic-bezier(0.4, 0, 0.2, 1) !important;
}

/* Light mode tab button */
html:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"],
body:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"],
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-light {
  color: rgb(63, 63, 58) !important;
  background-color: transparent !important;
}

html:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"]:hover,
body:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"]:hover,
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-light:hover {
  text-decoration: none !important;
  background-color: rgba(26, 27, 25, 0.04) !important;
  color: rgb(26, 27, 25) !important;
}

html:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"].Mui-selected,
html:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"][aria-pressed="true"],
body:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"].Mui-selected,
body:not(.dark) [data-testid="${TAB_BUTTON_TESTID}"][aria-pressed="true"],
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-light.Mui-selected {
  background-color: rgb(255, 255, 255) !important;
  color: rgb(26, 27, 25) !important;
  font-weight: 600 !important;
  box-shadow: rgba(0, 0, 0, 0.19) 0px 1px 2px !important;
}

/* Dark mode tab button */
html.dark [data-testid="${TAB_BUTTON_TESTID}"],
body.dark [data-testid="${TAB_BUTTON_TESTID}"],
html[data-theme="dark"] [data-testid="${TAB_BUTTON_TESTID}"],
body[data-theme="dark"] [data-testid="${TAB_BUTTON_TESTID}"],
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-dark {
  color: rgb(168, 168, 162) !important;
  background-color: transparent !important;
}

html.dark [data-testid="${TAB_BUTTON_TESTID}"]:hover,
body.dark [data-testid="${TAB_BUTTON_TESTID}"]:hover,
html[data-theme="dark"] [data-testid="${TAB_BUTTON_TESTID}"]:hover,
body[data-theme="dark"] [data-testid="${TAB_BUTTON_TESTID}"]:hover,
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-dark:hover {
  background-color: rgba(255, 255, 255, 0.08) !important;
  color: #ffffff !important;
}

html.dark [data-testid="${TAB_BUTTON_TESTID}"].Mui-selected,
html.dark [data-testid="${TAB_BUTTON_TESTID}"][aria-pressed="true"],
body.dark [data-testid="${TAB_BUTTON_TESTID}"].Mui-selected,
body.dark [data-testid="${TAB_BUTTON_TESTID}"][aria-pressed="true"],
html[data-theme="dark"] [data-testid="${TAB_BUTTON_TESTID}"].Mui-selected,
body[data-theme="dark"] [data-testid="${TAB_BUTTON_TESTID}"].Mui-selected,
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-dark.Mui-selected,
[data-testid="${TAB_BUTTON_TESTID}"].vs-theme-dark[aria-pressed="true"] {
  background-color: #21262d !important;
  color: rgb(240, 246, 252) !important;
  font-weight: 600 !important;
  box-shadow: rgba(0, 0, 0, 0.35) 0px 1px 2px !important;
}

/* Material-UI Navbar Tab Tooltip styles (100% match with Flow, Published, Log) */
.MuiPopper-root.vs-tab-tooltip-popper {
  z-index: 1500;
  pointer-events: none;
  position: fixed;
  opacity: 0;
  transform: scale(0.95);
  transition: opacity 200ms cubic-bezier(0.4, 0, 0.2, 1), transform 133ms cubic-bezier(0.4, 0, 0.2, 1);
}

.MuiPopper-root.vs-tab-tooltip-popper.show {
  opacity: 1;
  transform: scale(1);
}

.MuiTooltip-tooltip.vs-tab-tooltip-body {
  background-color: rgba(97, 97, 97, 0.92) !important;
  border-radius: 8px !important;
  color: rgb(255, 255, 255) !important;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  padding: 4px 8px !important;
  font-size: 0.6875rem !important;
  line-height: 1.4 !important;
  max-width: 300px !important;
  overflow-wrap: break-word !important;
  font-weight: 500 !important;
  position: relative !important;
  margin: 0px !important;
  margin-top: 14px !important;
  box-shadow: none !important;
  text-align: center !important;
  box-sizing: border-box !important;
}

.MuiTooltip-arrow.vs-tab-tooltip-arrow {
  overflow: hidden !important;
  position: absolute !important;
  top: 0px !important;
  margin-top: -0.71em !important;
  width: 1em !important;
  height: 0.71em !important;
  box-sizing: border-box !important;
  color: rgba(97, 97, 97, 0.92) !important;
}

.MuiTooltip-arrow.vs-tab-tooltip-arrow::before {
  content: "" !important;
  margin: auto !important;
  display: block !important;
  width: 100% !important;
  height: 100% !important;
  background-color: currentColor !important;
  transform: rotate(45deg) !important;
  transform-origin: 0px 100% !important;
}

/* Theme tokens: Dark theme (default) */
#${OVERLAY_ID},
#${OVERLAY_ID}.vs-theme-dark {
  --vs-g-bg: #0d1117;
  --vs-g-dot: rgba(255, 255, 255, 0.08);
  --vs-g-card-bg: rgb(21, 27, 35);
  --vs-g-card-border: rgba(255, 255, 255, 0.1);
  --vs-g-card-border-hover: rgba(255, 255, 255, 0.24);
  --vs-g-card-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  --vs-g-text-primary: rgb(240, 246, 252);
  --vs-g-text-secondary: #8b949e;
  --vs-g-text-muted: #6e7681;
  --vs-g-header-bg: rgba(255, 255, 255, 0.02);
  --vs-g-header-border: rgba(255, 255, 255, 0.06);
  --vs-g-section-bg: rgba(0, 0, 0, 0.22);
  --vs-g-section-border: rgba(255, 255, 255, 0.05);
  --vs-g-section-hover: rgba(255, 255, 255, 0.06);
  --vs-g-row-border: rgba(255, 255, 255, 0.04);
  --vs-g-row-hover: rgba(88, 166, 255, 0.12);
  --vs-g-nested-bg: rgba(0, 0, 0, 0.15);
  --vs-g-nested-border: rgba(110, 118, 129, 0.25);
  --vs-g-topbar-bg: rgba(21, 27, 35, 0.92);
  --vs-g-topbar-border: rgba(255, 255, 255, 0.15);
  --vs-g-topbar-text: #c9d1d9;
  --vs-g-filter-active-bg: rgba(255, 255, 255, 0.1);
  --vs-g-filter-active-text: #ffffff;
  --vs-g-back-btn-hover: #21262d;
  --vs-g-key: #79c0ff;
  --vs-g-str: #7ee787;
  --vs-g-num: #ffa657;
  --vs-g-bool: #58a6ff;
  --vs-g-null: #d2a8ff;
  --vs-g-badge-bg: rgba(88, 166, 255, 0.15);
  --vs-g-badge-text: #79c0ff;
  --vs-g-badge-border: rgba(88, 166, 255, 0.3);
  --vs-g-path: #58a6ff;
  --vs-g-path-hl: #79c0ff;
  --vs-g-port-border: rgba(255, 255, 255, 0.3);
  --vs-g-port-bg: rgb(21, 27, 35);
  --vs-g-indep-border: rgba(255, 255, 255, 0.15);
  --vs-g-modal-bg: #151b23;
  --vs-g-modal-header-bg: #161b22;
  --vs-g-modal-border: rgba(255, 255, 255, 0.12);
  --vs-g-modal-title: #f0f6fc;
}

/* Theme tokens: Light theme */
html:not(.dark) #${OVERLAY_ID},
body:not(.dark) #${OVERLAY_ID},
#${OVERLAY_ID}.vs-theme-light {
  --vs-g-bg: #f8fafc;
  --vs-g-dot: rgba(0, 0, 0, 0.09);
  --vs-g-card-bg: #ffffff;
  --vs-g-card-border: rgba(0, 0, 0, 0.12);
  --vs-g-card-border-hover: rgba(0, 0, 0, 0.28);
  --vs-g-card-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  --vs-g-text-primary: #1f2328;
  --vs-g-text-secondary: #656d76;
  --vs-g-text-muted: #8c959f;
  --vs-g-header-bg: rgba(0, 0, 0, 0.02);
  --vs-g-header-border: rgba(0, 0, 0, 0.08);
  --vs-g-section-bg: rgba(0, 0, 0, 0.03);
  --vs-g-section-border: rgba(0, 0, 0, 0.06);
  --vs-g-section-hover: rgba(0, 0, 0, 0.05);
  --vs-g-row-border: rgba(0, 0, 0, 0.05);
  --vs-g-row-hover: rgba(9, 105, 218, 0.05);
  --vs-g-nested-bg: rgba(0, 0, 0, 0.025);
  --vs-g-nested-border: rgba(0, 0, 0, 0.14);
  --vs-g-topbar-bg: rgba(255, 255, 255, 0.95);
  --vs-g-topbar-border: rgba(0, 0, 0, 0.14);
  --vs-g-topbar-text: #1f2328;
  --vs-g-filter-active-bg: rgba(0, 0, 0, 0.08);
  --vs-g-filter-active-text: #1f2328;
  --vs-g-back-btn-hover: #f3f4f6;
  --vs-g-key: #0550ae;
  --vs-g-str: #0a3069;
  --vs-g-num: #cf222e;
  --vs-g-bool: #953800;
  --vs-g-null: #8250df;
  --vs-g-badge-bg: rgba(9, 105, 218, 0.08);
  --vs-g-badge-text: #0969da;
  --vs-g-badge-border: rgba(9, 105, 218, 0.2);
  --vs-g-path: #0969da;
  --vs-g-path-hl: #0550ae;
  --vs-g-port-border: rgba(0, 0, 0, 0.3);
  --vs-g-port-bg: #ffffff;
  --vs-g-indep-border: rgba(0, 0, 0, 0.18);
  --vs-g-modal-bg: #ffffff;
  --vs-g-modal-header-bg: #f6f8fa;
  --vs-g-modal-border: rgba(0, 0, 0, 0.12);
  --vs-g-modal-title: #1f2328;
}

/* Explicit override when dark class is present */
html.dark #${OVERLAY_ID},
body.dark #${OVERLAY_ID},
html[data-theme="dark"] #${OVERLAY_ID},
body[data-theme="dark"] #${OVERLAY_ID} {
  --vs-g-bg: #0d1117;
  --vs-g-dot: rgba(255, 255, 255, 0.08);
  --vs-g-card-bg: rgb(21, 27, 35);
  --vs-g-card-border: rgba(255, 255, 255, 0.1);
  --vs-g-card-border-hover: rgba(255, 255, 255, 0.24);
  --vs-g-card-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  --vs-g-text-primary: rgb(240, 246, 252);
  --vs-g-text-secondary: #8b949e;
  --vs-g-text-muted: #6e7681;
  --vs-g-header-bg: rgba(255, 255, 255, 0.02);
  --vs-g-header-border: rgba(255, 255, 255, 0.06);
  --vs-g-section-bg: rgba(0, 0, 0, 0.22);
  --vs-g-section-border: rgba(255, 255, 255, 0.05);
  --vs-g-section-hover: rgba(255, 255, 255, 0.06);
  --vs-g-row-border: rgba(255, 255, 255, 0.04);
  --vs-g-row-hover: rgba(88, 166, 255, 0.12);
  --vs-g-nested-bg: rgba(0, 0, 0, 0.15);
  --vs-g-nested-border: rgba(110, 118, 129, 0.25);
  --vs-g-topbar-bg: rgba(21, 27, 35, 0.92);
  --vs-g-topbar-border: rgba(255, 255, 255, 0.15);
  --vs-g-topbar-text: #c9d1d9;
  --vs-g-filter-active-bg: rgba(255, 255, 255, 0.1);
  --vs-g-filter-active-text: #ffffff;
  --vs-g-back-btn-hover: #21262d;
  --vs-g-key: #79c0ff;
  --vs-g-str: #7ee787;
  --vs-g-num: #ffa657;
  --vs-g-bool: #58a6ff;
  --vs-g-null: #d2a8ff;
  --vs-g-badge-bg: rgba(88, 166, 255, 0.15);
  --vs-g-badge-text: #79c0ff;
  --vs-g-badge-border: rgba(88, 166, 255, 0.3);
  --vs-g-path: #58a6ff;
  --vs-g-path-hl: #79c0ff;
  --vs-g-port-border: rgba(255, 255, 255, 0.3);
  --vs-g-port-bg: rgb(21, 27, 35);
  --vs-g-indep-border: rgba(255, 255, 255, 0.15);
  --vs-g-modal-bg: #151b23;
  --vs-g-modal-header-bg: #161b22;
  --vs-g-modal-border: rgba(255, 255, 255, 0.12);
  --vs-g-modal-title: #f0f6fc;
}

#${OVERLAY_ID} {
  position: absolute;
  inset: 0;
  z-index: 200 !important;
  background-color: var(--vs-g-bg, #0d1117);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  color: var(--vs-g-text-primary, rgb(240, 246, 252));
}

/* Ensure step edit sliders and drawers sit above the graph canvas */
#flow-page-box .customSliderParent,
#flow-page-box .custom_slider,
#flow-page-box .sliderChild,
#flow-page-box .pointer-events-auto.absolute.right-0,
#flow-page-box .pointer-events-auto.absolute.inset-y-0.right-0,
#flow-page-box .MuiDrawer-root {
  z-index: 1200 !important;
}

/* Ensure the logs history drawer / popper and native logs chip sit above the graph canvas */
body.vs-graph-active [data-testid="workflow-navbar-logs-time-chip-container"],
body.vs-graph-active #logs-data-time-chip-anchor,
body.vs-graph-active [data-testid="logs-data-time-chip"],
body.vs-graph-active .MuiPopper-root:has(input[placeholder*="search" i]),
body.vs-graph-active .MuiPopper-root:has(input[placeholder*="history" i]),
body.vs-graph-active .MuiPopper-root:has([data-testid="logs-list-container"]),
body.vs-graph-active .MuiPopper-root:has([data-testid="logs-slider-card"]),
body.vs-graph-active .MuiPopper-root.z-\[50\] {
  z-index: 260 !important;
}

/* viaSocket dot grid canvas background */
.vs-graph-canvas-bg {
  position: absolute;
  inset: 0;
  background-color: var(--vs-g-bg, #0d1117);
  background-image: radial-gradient(circle, var(--vs-g-dot, rgba(255, 255, 255, 0.08)) 1.2px, transparent 1.2px);
  background-size: 20px 20px;
  pointer-events: none;
}

/* Floating top bar */
.vs-graph-top-bar {
  position: absolute;
  top: 12px;
  left: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  pointer-events: none;
  z-index: 25;
}

.vs-graph-top-left,
.vs-graph-top-center,
.vs-graph-top-right {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Run chip */
.vs-graph-run-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--vs-g-topbar-border, rgba(213, 217, 220, 0.24));
  background: var(--vs-g-topbar-bg, rgba(21, 27, 35, 0.92));
  backdrop-filter: blur(8px);
  font-size: 12px;
  color: var(--vs-g-text-secondary, #8b949e);
  box-shadow: var(--vs-g-card-shadow, 0 1px 3px rgba(0, 0, 0, 0.3));
  user-select: none;
}

.vs-graph-run-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: #10b981;
}

/* Filter buttons pill */
.vs-graph-filter-group {
  display: flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--vs-g-topbar-border, rgba(213, 217, 220, 0.24));
  background: var(--vs-g-topbar-bg, rgba(21, 27, 35, 0.92));
  backdrop-filter: blur(8px);
  padding: 2px;
  box-shadow: var(--vs-g-card-shadow, 0 1px 3px rgba(0, 0, 0, 0.3));
  user-select: none;
}

.vs-graph-filter-btn {
  background: transparent;
  border: none;
  color: var(--vs-g-text-secondary, #8b949e);
  font-size: 12px;
  font-weight: 500;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}

.vs-graph-filter-btn:hover {
  color: var(--vs-g-text-primary, #f0f6fc);
}

.vs-graph-filter-btn.active {
  background: var(--vs-g-filter-active-bg, rgba(255, 255, 255, 0.1));
  color: var(--vs-g-filter-active-text, #ffffff);
  font-weight: 600;
}

/* Back button */
.vs-graph-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--vs-g-topbar-border, rgba(213, 217, 220, 0.24));
  background: var(--vs-g-topbar-bg, rgba(21, 27, 35, 0.92));
  backdrop-filter: blur(8px);
  font-size: 12px;
  font-weight: 500;
  color: var(--vs-g-topbar-text, #c9d1d9);
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: var(--vs-g-card-shadow, 0 1px 3px rgba(0, 0, 0, 0.3));
  font-family: inherit;
  user-select: none;
}

.vs-graph-back-btn:hover {
  background: var(--vs-g-back-btn-hover, #21262d);
  color: var(--vs-g-text-primary, #ffffff);
}

/* Floating bottom zoom & notes controls */
.vs-graph-bottom-controls {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 210;
  pointer-events: auto;
  display: flex !important;
  align-items: center;
  justify-content: center;
}

.vs-graph-bottom-controls .MuiButtonGroup-root {
  background-color: var(--vs-g-topbar-bg, rgba(21, 27, 35, 0.92)) !important;
  border: 1px solid var(--vs-g-topbar-border, rgba(255, 255, 255, 0.15)) !important;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3) !important;
  backdrop-filter: blur(8px) !important;
  border-radius: 9999px !important;
  display: inline-flex !important;
  align-items: center !important;
  padding: 2px 4px !important;
}

.vs-graph-bottom-controls button {
  color: var(--vs-g-text-secondary, #8b949e) !important;
  padding: 6px 10px !important;
  min-width: 36px !important;
  height: 36px !important;
  border-radius: 9999px !important;
  transition: all 0.15s ease !important;
  border: none !important;
  background: transparent !important;
  cursor: pointer !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}

.vs-graph-bottom-controls button:hover {
  color: var(--vs-g-text-primary, #ffffff) !important;
  background-color: var(--vs-g-section-hover, rgba(255, 255, 255, 0.08)) !important;
}

.vs-graph-bottom-controls .MuiDivider-root {
  border-color: var(--vs-g-topbar-border, rgba(255, 255, 255, 0.12)) !important;
  height: 20px !important;
  margin: 0 4px !important;
}

.vs-graph-bottom-controls .vs-graph-zoom-level {
  color: var(--vs-g-text-primary, #ffffff);
  font-family: Inter, system-ui, -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 500;
  padding: 0 8px;
  min-width: 46px;
  text-align: center;
  user-select: none;
  margin: 0 !important;
}

/* Hide native flow controls in graph mode so there are no duplicate/conflicting bars */
body.vs-graph-active [data-testid="flow-controls-container"] {
  display: none !important;
}

/* Ensure flow document / comment component is above graph overlay */
body.vs-graph-active .comment-component,
body.vs-graph-active [class*="comment-component"] {
  z-index: 1200 !important;
}

/* Hide flow canvas help card when in graph view so it does not overlap Back to Flow */
body.vs-graph-active [data-testid="build-flow-card"] {
  display: none !important;
}

/* Viewport and transform layer */
.vs-graph-viewport {
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: grab;
  user-select: none;
}

.vs-graph-viewport.is-panning {
  cursor: grabbing;
}

.vs-graph-transform-layer {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}

/* SVG Connection Lines */
.vs-graph-svg {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none;
  z-index: 2;
}

.vs-graph-path-hitarea {
  fill: none;
  stroke: transparent;
  stroke-width: 14px;
  stroke-linecap: round;
  pointer-events: stroke;
  cursor: pointer;
}

.vs-graph-path {
  fill: none;
  stroke: var(--vs-g-path, #58a6ff);
  stroke-width: 2px;
  stroke-linecap: round;
  pointer-events: stroke;
  cursor: pointer;
  transition: stroke 0.15s ease, stroke-width 0.15s ease, opacity 0.2s ease, filter 0.15s ease;
  opacity: 0.85;
}

/* Dim non-active paths when one path is hovered or locked */
.vs-graph-svg.has-active-connection .vs-graph-path:not(.highlighted):not(.locked) {
  opacity: 0.12 !important;
  stroke-width: 1.5px !important;
}

.vs-graph-path:hover,
.vs-graph-path.highlighted,
.vs-graph-path.locked {
  stroke: #38bdf8 !important;
  stroke-width: 3.5px !important;
  opacity: 1 !important;
  filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.85)) !important;
  cursor: pointer;
}

html:not(.dark) .vs-graph-path:hover,
html:not(.dark) .vs-graph-path.highlighted,
html:not(.dark) .vs-graph-path.locked,
body:not(.dark) .vs-graph-path:hover,
body:not(.dark) .vs-graph-path.highlighted,
body:not(.dark) .vs-graph-path.locked,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-path:hover,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-path.highlighted,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-path.locked {
  stroke: #0284c7 !important;
  filter: drop-shadow(0 0 6px rgba(2, 132, 199, 0.75)) !important;
}

.vs-graph-path.pulse-anim {
  stroke-dasharray: 6, 4;
  animation: vs-flow-dash 1.2s linear infinite;
}

.vs-graph-path.locked {
  stroke-dasharray: 8, 4 !important;
  animation: vs-flow-dash 1s linear infinite !important;
}

.vs-graph-path.sequential {
  stroke: var(--vs-g-path, #58a6ff);
  stroke-width: 1.8px;
  stroke-dasharray: 6, 4;
  opacity: 0.65;
}

.vs-graph-path.sequential:hover,
.vs-graph-path.sequential.highlighted,
.vs-graph-path.sequential.locked {
  stroke: #38bdf8 !important;
  stroke-width: 3px !important;
  opacity: 1 !important;
  stroke-dasharray: 8, 4;
}

html:not(.dark) .vs-graph-path.sequential:hover,
html:not(.dark) .vs-graph-path.sequential.highlighted,
html:not(.dark) .vs-graph-path.sequential.locked,
body:not(.dark) .vs-graph-path.sequential:hover,
body:not(.dark) .vs-graph-path.sequential.highlighted,
body:not(.dark) .vs-graph-path.sequential.locked,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-path.sequential:hover,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-path.sequential.highlighted,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-path.sequential.locked {
  stroke: #0284c7 !important;
}

@keyframes vs-flow-dash {
  from { stroke-dashoffset: 20; }
  to { stroke-dashoffset: 0; }
}

/* Nodes layer */
.vs-graph-nodes-layer {
  position: relative;
  z-index: 3;
}

/* Native viaSocket Card Style (JSON Crack-inspired property tables) */
.vs-graph-card {
  position: absolute;
  z-index: 5;
  width: 360px;
  background-color: var(--vs-g-card-bg, rgb(21, 27, 35));
  border: 1.5px solid var(--vs-g-card-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  box-shadow: var(--vs-g-card-shadow, 0 4px 14px rgba(0, 0, 0, 0.45));
  color: var(--vs-g-text-primary, rgb(240, 246, 252));
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  user-select: none;
  overflow: visible;
}

.vs-graph-card:hover {
  border-color: var(--vs-g-card-border-hover, rgba(255, 255, 255, 0.24));
  box-shadow: var(--vs-g-card-shadow, 0 6px 18px rgba(0, 0, 0, 0.55));
  z-index: 7;
}

.vs-graph-card.selected {
  border-color: var(--vs-g-path, #58a6ff);
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.25);
  z-index: 8;
}

/* Header */
.vs-graph-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vs-g-header-bg, rgba(255, 255, 255, 0.02));
  border-bottom: 1px solid var(--vs-g-header-border, rgba(255, 255, 255, 0.06));
  border-top-left-radius: 7px;
  border-top-right-radius: 7px;
}

.vs-graph-card-avatar {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vs-g-header-bg, #161b22);
}

.vs-graph-card-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.vs-graph-card-title-box {
  flex: 1;
  min-width: 0;
}

.vs-graph-card-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.vs-graph-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vs-g-text-primary, rgb(240, 246, 252));
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.vs-graph-status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2.5px 7px;
  border-radius: 12px;
  white-space: nowrap;
  letter-spacing: 0.01em;
  user-select: none;
  flex-shrink: 0;
}

/* Light Theme Chips */
html:not(.dark) .vs-graph-status-chip.newly_added,
body:not(.dark) .vs-graph-status-chip.newly_added,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-status-chip.newly_added {
  background: rgba(46, 125, 50, 0.12);
  color: rgb(27, 94, 32);
  border: 1px solid rgba(46, 125, 50, 0.28);
}

html:not(.dark) .vs-graph-status-chip.modified,
body:not(.dark) .vs-graph-status-chip.modified,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-status-chip.modified {
  background: rgba(2, 136, 209, 0.12);
  color: rgb(2, 119, 189);
  border: 1px solid rgba(2, 136, 209, 0.28);
}

html:not(.dark) .vs-graph-status-chip.deleted,
body:not(.dark) .vs-graph-status-chip.deleted,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-status-chip.deleted {
  background: rgba(211, 47, 47, 0.12);
  color: rgb(198, 40, 40);
  border: 1px solid rgba(211, 47, 47, 0.28);
}

html:not(.dark) .vs-graph-status-chip.paused,
body:not(.dark) .vs-graph-status-chip.paused,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-status-chip.paused {
  background: rgba(245, 127, 23, 0.14);
  color: rgb(217, 119, 6);
  border: 1px solid rgba(245, 127, 23, 0.3);
}

html:not(.dark) .vs-graph-status-chip.unsaved,
body:not(.dark) .vs-graph-status-chip.unsaved,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-status-chip.unsaved {
  background: rgba(237, 108, 2, 0.12);
  color: rgb(230, 81, 0);
  border: 1px solid rgba(237, 108, 2, 0.28);
}

/* Dark Theme Chips */
html.dark .vs-graph-status-chip.newly_added,
body.dark .vs-graph-status-chip.newly_added,
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-status-chip.newly_added {
  background: rgba(46, 125, 50, 0.22);
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.35);
}

html.dark .vs-graph-status-chip.modified,
body.dark .vs-graph-status-chip.modified,
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-status-chip.modified {
  background: rgba(2, 136, 209, 0.22);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.35);
}

html.dark .vs-graph-status-chip.deleted,
body.dark .vs-graph-status-chip.deleted,
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-status-chip.deleted {
  background: rgba(211, 47, 47, 0.22);
  color: #f87171;
  border: 1px solid rgba(248, 113, 113, 0.35);
}

html.dark .vs-graph-status-chip.paused,
body.dark .vs-graph-status-chip.paused,
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-status-chip.paused {
  background: rgba(245, 127, 23, 0.22);
  color: #fde047;
  border: 1px solid rgba(253, 224, 71, 0.35);
}

html.dark .vs-graph-status-chip.unsaved,
body.dark .vs-graph-status-chip.unsaved,
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-status-chip.unsaved {
  background: rgba(237, 108, 2, 0.22);
  color: #fb923c;
  border: 1px solid rgba(251, 146, 60, 0.35);
}

/* Card Body Status Styling - Light Mode */
html:not(.dark) .vs-graph-card[data-status="newly_added"],
body:not(.dark) .vs-graph-card[data-status="newly_added"],
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card[data-status="newly_added"] {
  background-color: #f4fbf5;
  border-color: rgba(46, 125, 50, 0.35);
}

html:not(.dark) .vs-graph-card[data-status="modified"],
body:not(.dark) .vs-graph-card[data-status="modified"],
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card[data-status="modified"] {
  background-color: #f0f7ff;
  border-color: rgba(2, 136, 209, 0.35);
}

html:not(.dark) .vs-graph-card[data-status="deleted"],
body:not(.dark) .vs-graph-card[data-status="deleted"],
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card[data-status="deleted"] {
  background-color: #fff5f5;
  border-color: rgba(211, 47, 47, 0.35);
}

html:not(.dark) .vs-graph-card[data-status="paused"],
body:not(.dark) .vs-graph-card[data-status="paused"],
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card[data-status="paused"] {
  background-color: #fffdf2;
  border-color: rgba(245, 127, 23, 0.35);
}

html:not(.dark) .vs-graph-card[data-status="unsaved"],
body:not(.dark) .vs-graph-card[data-status="unsaved"],
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card[data-status="unsaved"] {
  background-color: #fffbf2;
  border-color: rgba(237, 108, 2, 0.35);
}

/* Active body is always white in light mode */
html:not(.dark) .vs-graph-card,
html:not(.dark) .vs-graph-card[data-status="active"],
body:not(.dark) .vs-graph-card,
body:not(.dark) .vs-graph-card[data-status="active"],
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card[data-status="active"] {
  background-color: #ffffff;
}

/* Card Body Status Styling - Dark Mode */
html.dark .vs-graph-card[data-status="newly_added"],
body.dark .vs-graph-card[data-status="newly_added"],
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card[data-status="newly_added"] {
  background-color: rgba(46, 125, 50, 0.08);
  border-color: rgba(74, 222, 128, 0.35);
}

html.dark .vs-graph-card[data-status="modified"],
body.dark .vs-graph-card[data-status="modified"],
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card[data-status="modified"] {
  background-color: rgba(2, 136, 209, 0.08);
  border-color: rgba(56, 189, 248, 0.35);
}

html.dark .vs-graph-card[data-status="deleted"],
body.dark .vs-graph-card[data-status="deleted"],
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card[data-status="deleted"] {
  background-color: rgba(211, 47, 47, 0.08);
  border-color: rgba(248, 113, 113, 0.35);
}

html.dark .vs-graph-card[data-status="paused"],
body.dark .vs-graph-card[data-status="paused"],
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card[data-status="paused"] {
  background-color: rgba(245, 127, 23, 0.08);
  border-color: rgba(253, 224, 71, 0.35);
}

html.dark .vs-graph-card[data-status="unsaved"],
body.dark .vs-graph-card[data-status="unsaved"],
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card[data-status="unsaved"] {
  background-color: rgba(237, 108, 2, 0.08);
  border-color: rgba(251, 146, 60, 0.35);
}

html.dark .vs-graph-card,
html.dark .vs-graph-card[data-status="active"],
body.dark .vs-graph-card,
body.dark .vs-graph-card[data-status="active"],
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card,
#vs-dependency-graph-overlay:not(.vs-theme-light) .vs-graph-card[data-status="active"] {
  background-color: rgb(21, 27, 35);
}

/* Card Connected Highlight */
.vs-graph-card.card-connected-highlight {
  border-color: #38bdf8 !important;
  box-shadow: 0 0 0 2px #38bdf8, 0 8px 24px rgba(56, 189, 248, 0.28) !important;
  z-index: 10 !important;
  transition: border-color 0.15s ease, box-shadow 0.15s ease !important;
}

html:not(.dark) .vs-graph-card.card-connected-highlight,
body:not(.dark) .vs-graph-card.card-connected-highlight,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-card.card-connected-highlight {
  border-color: #0284c7 !important;
  box-shadow: 0 0 0 2px #0284c7, 0 8px 20px rgba(2, 132, 199, 0.24) !important;
}

/* Floating Lock Banner Pill */
.vs-graph-lock-pill {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 220;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-radius: 9999px;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  font-size: 12px;
  font-weight: 500;
  background: rgba(13, 17, 23, 0.94);
  border: 1px solid rgba(56, 189, 248, 0.5);
  box-shadow: 0 4px 18px rgba(56, 189, 248, 0.25), 0 2px 8px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(10px);
  color: #f0f6fc;
  pointer-events: auto;
  user-select: none;
  animation: vs-pill-pop 0.18s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

html:not(.dark) .vs-graph-lock-pill,
body:not(.dark) .vs-graph-lock-pill,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-lock-pill {
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(2, 132, 199, 0.45);
  box-shadow: 0 4px 16px rgba(2, 132, 199, 0.2), 0 2px 6px rgba(0, 0, 0, 0.08);
  color: #1f2328;
}

@keyframes vs-pill-pop {
  from { opacity: 0; transform: translate(-50%, -8px) scale(0.95); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}

.vs-graph-lock-pill .vs-lock-icon {
  font-size: 13px;
  color: #38bdf8;
}

html:not(.dark) .vs-graph-lock-pill .vs-lock-icon,
body:not(.dark) .vs-graph-lock-pill .vs-lock-icon,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-lock-pill .vs-lock-icon {
  color: #0284c7;
}

.vs-graph-lock-pill .vs-lock-text {
  font-weight: 500;
}

.vs-graph-lock-pill .vs-lock-val {
  color: #38bdf8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

html:not(.dark) .vs-graph-lock-pill .vs-lock-val,
body:not(.dark) .vs-graph-lock-pill .vs-lock-val,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-lock-pill .vs-lock-val {
  color: #0284c7;
}

.vs-graph-lock-pill .vs-lock-hint {
  margin-left: 6px;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  background: rgba(56, 189, 248, 0.15);
  color: #7dd3fc;
  border: 1px solid rgba(56, 189, 248, 0.3);
  font-weight: 600;
}

html:not(.dark) .vs-graph-lock-pill .vs-lock-hint,
body:not(.dark) .vs-graph-lock-pill .vs-lock-hint,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-lock-pill .vs-lock-hint {
  background: rgba(2, 132, 199, 0.1);
  color: #0284c7;
  border-color: rgba(2, 132, 199, 0.25);
}

.vs-graph-lock-pill .vs-lock-close {
  background: transparent;
  border: none;
  color: #8b949e;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: all 0.15s ease;
  margin-left: 4px;
}

.vs-graph-lock-pill .vs-lock-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #f87171;
}

/* Tooltip shortcut hint */
.vs-graph-tip-shortcut {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  color: #38bdf8;
  opacity: 0.95;
  font-weight: 500;
}

html:not(.dark) .vs-graph-tip-shortcut,
body:not(.dark) .vs-graph-tip-shortcut,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-tip-shortcut {
  color: #0284c7;
}

.vs-graph-card-url {
  font-size: 11px;
  color: var(--vs-g-text-secondary, #8b949e);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vs-graph-card-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.vs-graph-card-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--vs-g-header-bg, rgba(255, 255, 255, 0.08));
  color: var(--vs-g-text-secondary, #8b949e);
}

.vs-graph-card-badge.indep {
  background: rgba(16, 185, 129, 0.12);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.vs-graph-edit-btn,
.vs-graph-menu-btn {
  background: transparent;
  border: none;
  color: var(--vs-g-text-secondary, #8b949e);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.vs-graph-edit-btn:hover,
.vs-graph-menu-btn:hover {
  color: var(--vs-g-text-primary, #f0f6fc);
  background-color: var(--vs-g-section-hover, rgba(255, 255, 255, 0.08));
}

/* JSON Crack-style Structured Node Table */
.vs-graph-section {
  width: 100%;
}

.vs-graph-section.output-section {
  border-top: 1px solid var(--vs-g-section-border, rgba(255, 255, 255, 0.08));
}

.vs-graph-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  background: var(--vs-g-section-bg, rgba(0, 0, 0, 0.22));
  border-bottom: 1px solid var(--vs-g-section-border, rgba(255, 255, 255, 0.05));
  cursor: pointer;
  user-select: none;
  transition: background-color 0.12s ease;
}

.vs-graph-section-header:hover {
  background: var(--vs-g-section-hover, rgba(255, 255, 255, 0.06));
}

.vs-graph-section-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vs-graph-section-chevron {
  font-size: 10px;
  color: var(--vs-g-text-secondary, #8b949e);
  line-height: 1;
  display: inline-block;
  transition: transform 0.15s ease, color 0.15s ease;
}

.vs-graph-section-header:hover .vs-graph-section-chevron {
  color: var(--vs-g-text-primary, #f0f6fc);
}

.vs-graph-section.collapsed .vs-graph-section-chevron {
  transform: rotate(-90deg);
}

.vs-graph-section.collapsed .vs-graph-section-header {
  border-bottom: none;
}

.vs-graph-section.collapsed .vs-graph-rows-list {
  display: none !important;
}

.vs-graph-section-tag {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--vs-g-text-secondary, #8b949e);
  text-transform: uppercase;
  font-family: Inter, system-ui, sans-serif;
  transition: color 0.12s ease;
}

.vs-graph-section-header:hover .vs-graph-section-tag {
  color: var(--vs-g-text-primary, #c9d1d9);
}

.vs-graph-section-count {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--vs-g-header-bg, rgba(255, 255, 255, 0.06));
  color: var(--vs-g-text-secondary, #8b949e);
  font-family: ui-monospace, monospace;
}

.vs-graph-rows-list {
  display: flex;
  flex-direction: column;
}

/* Individual Variable Row & Tree Item (JSON Crack style expandable hierarchy) */
.vs-graph-tree-item,
.vs-graph-nested-tree-item {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.vs-graph-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 11px;
  line-height: 1.4;
  border-bottom: 1px solid var(--vs-g-row-border, rgba(255, 255, 255, 0.04));
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
  user-select: text;
}

.vs-graph-row:last-child {
  border-bottom: none;
}

.vs-graph-row:hover,
.vs-graph-row.highlighted {
  background-color: var(--vs-g-row-hover, rgba(88, 166, 255, 0.12));
}

.vs-graph-row.highlighted-source {
  background-color: var(--vs-g-row-hover, rgba(88, 166, 255, 0.18));
}

/* Expand / Collapse Button matching JSON Crack */
.vs-graph-expand-btn {
  width: 14px;
  height: 14px;
  min-width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--vs-g-header-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--vs-g-section-border, rgba(255, 255, 255, 0.12));
  border-radius: 3px;
  color: var(--vs-g-text-secondary, #8b949e);
  font-size: 11px;
  line-height: 1;
  font-family: ui-monospace, monospace;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
  margin-right: 2px;
  transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  user-select: none;
  flex-shrink: 0;
}

.vs-graph-expand-btn:hover {
  background: var(--vs-g-badge-bg, rgba(88, 166, 255, 0.2));
  border-color: var(--vs-g-badge-border, rgba(88, 166, 255, 0.4));
  color: var(--vs-g-text-primary, #ffffff);
}

.vs-graph-expand-placeholder {
  width: 14px;
  min-width: 14px;
  height: 14px;
  margin-right: 2px;
  flex-shrink: 0;
}

/* Nested Container with JSON tree guide lines */
.vs-graph-nested-container {
  display: flex;
  flex-direction: column;
  margin-left: 14px;
  padding-left: 6px;
  border-left: 1.5px solid var(--vs-g-nested-border, rgba(110, 118, 129, 0.25));
  background: var(--vs-g-nested-bg, rgba(0, 0, 0, 0.15));
  border-radius: 0 0 4px 4px;
  transition: border-color 0.15s ease;
}

.vs-graph-nested-container:hover {
  border-left-color: var(--vs-g-path, rgba(88, 166, 255, 0.5));
}

.vs-graph-nested-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3.5px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 10.5px;
  line-height: 1.35;
  border-bottom: 1px solid var(--vs-g-row-border, rgba(255, 255, 255, 0.03));
  cursor: pointer;
  transition: background-color 0.12s ease;
  user-select: text;
}

.vs-graph-nested-row:last-child {
  border-bottom: none;
}

.vs-graph-nested-row:hover,
.vs-graph-nested-row.highlighted {
  background-color: var(--vs-g-row-hover, rgba(88, 166, 255, 0.1));
}

.vs-graph-nested-row.highlighted-source {
  background-color: var(--vs-g-row-hover, rgba(88, 166, 255, 0.16));
}

.vs-graph-row-key {
  color: var(--vs-g-key, #79c0ff);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
  flex-shrink: 0;
}

.vs-graph-nested-row .vs-graph-row-key {
  max-width: 120px;
  font-size: 10.5px;
}

.vs-row-index {
  color: var(--vs-g-path, #a5d6ff);
  font-weight: 500;
  opacity: 0.9;
}

.vs-graph-row-colon {
  color: var(--vs-g-text-muted, #6e7681);
  font-weight: 400;
  flex-shrink: 0;
}

.vs-graph-row-val {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
  font-weight: 400;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.vs-graph-row-inspect-btn {
  opacity: 0;
  background: transparent;
  border: none;
  color: var(--vs-g-text-secondary, #8b949e);
  cursor: pointer;
  padding: 0 2px;
  font-size: 10px;
  line-height: 1;
  transition: opacity 0.12s ease, color 0.12s ease;
  margin-left: 4px;
  flex-shrink: 0;
}

.vs-graph-row:hover .vs-graph-row-inspect-btn,
.vs-graph-nested-row:hover .vs-graph-row-inspect-btn {
  opacity: 0.7;
}

.vs-graph-row-inspect-btn:hover {
  opacity: 1 !important;
  color: var(--vs-g-path, #58a6ff);
}

.vs-graph-show-more-row {
  padding: 4px 10px;
  font-size: 10px;
  color: var(--vs-g-path, #58a6ff);
  cursor: pointer;
  font-family: ui-monospace, monospace;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
  user-select: none;
  transition: color 0.12s ease, background-color 0.12s ease;
}

.vs-graph-show-more-row:hover {
  color: var(--vs-g-path-hl, #79c0ff);
  background-color: var(--vs-g-row-hover, rgba(88, 166, 255, 0.08));
}

/* Syntax highlighted value types (inspired by JSON Crack & GitHub dark) */
.vs-val-str {
  color: var(--vs-g-str, #7ee787);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vs-val-num {
  color: var(--vs-g-num, #ffa657);
  font-weight: 500;
}

.vs-val-bool {
  color: var(--vs-g-bool, #58a6ff);
  font-weight: 600;
}

.vs-val-null {
  color: var(--vs-g-null, #8b949e);
  font-style: italic;
}

.vs-val-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
  border: 1px solid var(--vs-g-card-border, rgba(255, 255, 255, 0.2));
  flex-shrink: 0;
}

.vs-val-badge {
  display: inline-block;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  background: var(--vs-g-header-bg, rgba(110, 118, 129, 0.18));
  border: 1px solid var(--vs-g-section-border, rgba(255, 255, 255, 0.08));
  color: var(--vs-g-text-secondary, #c9d1d9);
}

.vs-val-badge.expandable {
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.vs-val-badge.expandable:hover {
  background-color: var(--vs-g-badge-bg, rgba(88, 166, 255, 0.2));
  border-color: var(--vs-g-badge-border, rgba(88, 166, 255, 0.4));
}

.vs-val-array {
  color: var(--vs-g-null, #d2a8ff);
  border-color: var(--vs-g-badge-border, rgba(210, 168, 255, 0.25));
  background: var(--vs-g-badge-bg, rgba(210, 168, 255, 0.08));
}

.vs-val-obj {
  color: var(--vs-g-key, #a5d6ff);
  border-color: var(--vs-g-badge-border, rgba(165, 214, 255, 0.25));
  background: var(--vs-g-badge-bg, rgba(165, 214, 255, 0.08));
}

/* Minimal port connection dots anchored directly on row */
.vs-graph-port-dot {
  position: absolute;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--vs-g-port-bg, #151b23);
  border: 1.5px solid var(--vs-g-path, #58a6ff);
  transition: all 0.15s ease;
  z-index: 5;
  top: 50%;
  transform: translateY(-50%);
}

.vs-graph-port-dot.port-in {
  left: -5px;
}

.vs-graph-port-dot.port-out {
  right: -5px;
}

.vs-graph-port-dot:hover,
.vs-graph-port-dot.highlighted {
  background-color: var(--vs-g-path, #58a6ff);
  box-shadow: 0 0 8px var(--vs-g-path, #58a6ff);
  transform: translateY(-50%) scale(1.35);
}

/* Independent lane */
.vs-graph-independent-lane {
  position: absolute;
  border: 1px dashed var(--vs-g-indep-border, rgba(255, 255, 255, 0.14));
  background: var(--vs-g-header-bg, rgba(255, 255, 255, 0.015));
  border-radius: 10px;
  padding: 16px 20px;
  z-index: 1;
  pointer-events: none;
}

.vs-graph-lane-header {
  position: absolute;
  top: -11px;
  left: 18px;
  background: var(--vs-g-bg, #0d1117);
  padding: 0 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--vs-g-text-secondary, #8b949e);
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}

/* Tooltip floating bubble */
.vs-graph-tooltip {
  position: fixed;
  z-index: 2000;
  background: rgba(30, 36, 46, 0.96);
  color: #ffffff;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 11px;
  font-family: inherit;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  display: none;
  line-height: 1.45;
  max-width: 340px;
  word-break: break-word;
}

html:not(.dark) .vs-graph-tooltip,
body:not(.dark) .vs-graph-tooltip,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-tooltip {
  background: rgba(255, 255, 255, 0.98);
  color: #1f2937;
  border: 1px solid rgba(0, 0, 0, 0.12);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.vs-graph-tip-title {
  font-weight: 600;
  color: #ffffff;
}

html:not(.dark) .vs-graph-tip-title,
body:not(.dark) .vs-graph-tip-title,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-tip-title {
  color: #111827;
}

.vs-graph-tip-detail {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10.5px;
  color: #93c5fd;
  margin-top: 2px;
}

html:not(.dark) .vs-graph-tip-detail,
body:not(.dark) .vs-graph-tip-detail,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-tip-detail {
  color: #0284c7;
}

.vs-graph-tip-shortcut {
  margin-top: 4px;
  font-size: 10px;
  color: #cbd5e1;
  opacity: 0.85;
}

html:not(.dark) .vs-graph-tip-shortcut,
body:not(.dark) .vs-graph-tip-shortcut,
#vs-dependency-graph-overlay.vs-theme-light .vs-graph-tip-shortcut {
  color: #64748b;
}

/* JSON Details Modal */
.vs-graph-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vs-graph-modal {
  width: 600px;
  max-width: 92vw;
  max-height: 82vh;
  background: var(--vs-g-modal-bg, #151b23);
  border: 1px solid var(--vs-g-modal-border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  position: relative;
}

.vs-graph-modal-header {
  padding: 10px 16px;
  border-bottom: 1px solid var(--vs-g-modal-border, rgba(255, 255, 255, 0.08));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--vs-g-modal-header-bg, #161b22);
}

.vs-graph-modal-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vs-g-modal-title, #f0f6fc);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.vs-graph-modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.vs-graph-modal-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  font-size: 11.5px;
  font-weight: 500;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  color: var(--vs-g-topbar-text, #c9d1d9);
  background: var(--vs-g-header-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--vs-g-modal-border, rgba(255, 255, 255, 0.14));
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
  line-height: 1.3;
}

.vs-graph-modal-btn:hover {
  background: var(--vs-g-back-btn-hover, rgba(255, 255, 255, 0.12));
  border-color: var(--vs-g-card-border-hover, rgba(255, 255, 255, 0.28));
  color: var(--vs-g-text-primary, #ffffff);
}

.vs-graph-modal-btn.copy {
  color: var(--vs-g-path, #58a6ff);
  border-color: var(--vs-g-badge-border, rgba(88, 166, 255, 0.3));
  background: var(--vs-g-badge-bg, rgba(88, 166, 255, 0.08));
}

.vs-graph-modal-btn.copy:hover {
  background: var(--vs-g-badge-bg, rgba(88, 166, 255, 0.18));
  border-color: var(--vs-g-path-hl, rgba(88, 166, 255, 0.5));
  color: var(--vs-g-path-hl, #79c0ff);
}

.vs-graph-modal-btn.copied {
  background: rgba(46, 160, 67, 0.15) !important;
  border-color: rgba(46, 160, 67, 0.45) !important;
  color: #3fb950 !important;
}

.vs-graph-modal-btn.close:hover {
  background: rgba(248, 81, 73, 0.15);
  border-color: rgba(248, 81, 73, 0.4);
  color: #f85149;
}

.vs-graph-modal-body-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.vs-graph-modal-body {
  padding: 16px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--vs-g-modal-title, #c9d1d9);
  background: var(--vs-g-bg, #0d1117);
  margin: 0;
  max-height: calc(82vh - 55px);
  user-select: text;
}
`

function ensureStyles(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = CSS
}

export interface DependencyGraphController {
  open(): Promise<void>
  close(): void
  refresh(): Promise<void>
  destroy(): void
}

export function initDependencyGraphUI(bridge: PageBridge): DependencyGraphController {
  ensureStyles()

  let isGraphActive = false
  let overlayEl: HTMLElement | null = null
  let currentGraphData: FlowGraphData | null = null
  let currentFilter: 'all' | 'dependent' | 'independent' = 'all'

  let pan = { x: 80, y: 70 }
  let zoom = 1.0
  let isDragging = false
  let dragStart = { x: 0, y: 0 }
  let panStart = { x: 0, y: 0 }

  let lastDrawerOpen = false
  let lastFlowHitId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('flowhitid') || '' : ''
  let lastTimestamp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('timestamp') || '' : ''
  const collapsedSections = new Set<string>()
  const expandedPaths = new Set<string>()
  let savedNativeZoomText = ''

  let tooltipEl: HTMLElement | null = null
  let tabTooltipEl: HTMLElement | null = null
  let tabTooltipTimer: ReturnType<typeof setTimeout> | undefined

  function isDarkMode(): boolean {
    if (document.documentElement.classList.contains('dark') || document.body.classList.contains('dark')) return true
    if (
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.body.getAttribute('data-theme') === 'dark'
    )
      return true
    const body = document.body
    if (body) {
      const color = window.getComputedStyle(body).color || ''
      const match = color.match(/\d+/g)
      if (match && match.length >= 3) {
        const lum = 0.299 * Number(match[0]) + 0.587 * Number(match[1]) + 0.114 * Number(match[2])
        if (lum > 150) return true
        if (lum < 100) return false
      }
    }
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  }

  function updateGraphTheme(): void {
    const isDark = isDarkMode()
    const targetThemeClass = isDark ? 'vs-theme-dark' : 'vs-theme-light'
    const removeThemeClass = isDark ? 'vs-theme-light' : 'vs-theme-dark'

    if (overlayEl) {
      overlayEl.classList.remove(removeThemeClass)
      overlayEl.classList.add(targetThemeClass)
    }

    const tabsContainer = document.querySelector('[data-testid="workflow-view-tabs"]')
    const graphBtn = tabsContainer?.querySelector(`[data-testid="${TAB_BUTTON_TESTID}"]`)
    if (graphBtn) {
      graphBtn.classList.remove(removeThemeClass)
      graphBtn.classList.add(targetThemeClass)
    }
  }

  const themeObserver = new MutationObserver(() => {
    updateGraphTheme()
  })
  if (typeof document !== 'undefined') {
    if (document.documentElement) {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'style'],
      })
    }
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'style'],
      })
    }
  }

  function showTabTooltip(target: HTMLElement, text: string): void {
    hideTabTooltip()
    const rect = target.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const popper = document.createElement('div')
    popper.setAttribute('role', 'tooltip')
    popper.className =
      'MuiPopper-root MuiTooltip-popper MuiTooltip-popperInteractive MuiTooltip-popperArrow css-1y1ein3 vs-tab-tooltip-popper'
    popper.setAttribute('data-popper-placement', 'bottom')

    const tooltip = document.createElement('div')
    tooltip.className =
      'MuiTooltip-tooltip MuiTooltip-tooltipArrow MuiTooltip-tooltipPlacementBottom css-v4npsm vs-tab-tooltip-body'
    tooltip.innerText = text

    const arrow = document.createElement('span')
    arrow.className = 'MuiTooltip-arrow css-6exv95 vs-tab-tooltip-arrow'

    tooltip.appendChild(arrow)
    popper.appendChild(tooltip)
    document.body.appendChild(popper)
    tabTooltipEl = popper

    const tooltipRect = tooltip.getBoundingClientRect()
    const left = rect.left + rect.width / 2 - tooltipRect.width / 2
    const maxLeft = window.innerWidth - tooltipRect.width - 12
    const clampedLeft = Math.max(12, Math.min(left, maxLeft))

    popper.style.left = `${Math.round(clampedLeft)}px`
    popper.style.top = `${Math.round(rect.bottom)}px`

    const arrowX = rect.left + rect.width / 2 - clampedLeft - 5.5
    arrow.style.left = '0px'
    arrow.style.transform = `translate3d(${Math.round(arrowX)}px, 0px, 0px)`

    requestAnimationFrame(() => {
      if (tabTooltipEl === popper) {
        popper.classList.add('show')
      }
    })
  }

  function hideTabTooltip(): void {
    if (tabTooltipTimer) {
      clearTimeout(tabTooltipTimer)
      tabTooltipTimer = undefined
    }
    if (tabTooltipEl) {
      const el = tabTooltipEl
      tabTooltipEl = null
      el.classList.remove('show')
      setTimeout(() => {
        el.remove()
      }, 150)
    }
  }

  function getTooltip(): HTMLElement {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div')
      tooltipEl.className = 'vs-graph-tooltip'
      document.body.appendChild(tooltipEl)
    }
    return tooltipEl
  }

  function showTooltip(x: number, y: number, text: string, shortcutHint?: string, detail?: string): void {
    const el = getTooltip()
    let html = `<div class="vs-graph-tip-title">${escapeHtml(text)}</div>`
    if (detail) {
      html += `<div class="vs-graph-tip-detail">${escapeHtml(detail)}</div>`
    }
    if (shortcutHint) {
      html += `<div class="vs-graph-tip-shortcut">${escapeHtml(shortcutHint)}</div>`
    }
    el.innerHTML = html
    el.style.display = 'block'

    const pad = 12
    const tipWidth = el.offsetWidth || 240
    const tipHeight = el.offsetHeight || 50
    const maxX = window.innerWidth - tipWidth - 16
    const maxY = window.innerHeight - tipHeight - 16

    let left = x + pad
    let top = y + pad

    if (left > maxX) {
      left = Math.max(16, x - tipWidth - pad)
    }
    if (top > maxY) {
      top = Math.max(16, y - tipHeight - pad)
    }

    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }

  function hideTooltip(): void {
    if (tooltipEl) tooltipEl.style.display = 'none'
  }

  function showDetailsModal(title: string, data: unknown): void {
    const backdrop = document.createElement('div')
    backdrop.className = 'vs-graph-modal-backdrop'

    const modal = document.createElement('div')
    modal.className = 'vs-graph-modal'

    const header = document.createElement('div')
    header.className = 'vs-graph-modal-header'

    const titleEl = document.createElement('div')
    titleEl.className = 'vs-graph-modal-title'
    titleEl.innerText = title

    const actionsEl = document.createElement('div')
    actionsEl.className = 'vs-graph-modal-actions'

    // Formatted text representation for preview & clipboard copy
    let textToDisplay = ''
    try {
      if (typeof data === 'string') {
        const trimmed = data.trim()
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            textToDisplay = JSON.stringify(JSON.parse(trimmed), null, 2)
          } catch {
            textToDisplay = data
          }
        } else {
          textToDisplay = data
        }
      } else {
        textToDisplay = JSON.stringify(data, null, 2)
      }
    } catch {
      textToDisplay = String(data)
    }

    const copyBtn = document.createElement('button')
    copyBtn.className = 'vs-graph-modal-btn copy'
    copyBtn.type = 'button'
    copyBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy Value</span>
    `
    copyBtn.title = 'Copy value to clipboard'

    let copyTimeout: ReturnType<typeof setTimeout> | undefined
    const triggerCopy = async () => {
      let copied = false
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(textToDisplay)
          copied = true
        }
      } catch {
        // Fallback to execCommand
      }

      if (!copied) {
        try {
          const ta = document.createElement('textarea')
          ta.value = textToDisplay
          ta.style.position = 'fixed'
          ta.style.top = '0'
          ta.style.left = '0'
          ta.style.opacity = '0.01'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          document.execCommand('copy')
          ta.remove()
        } catch {
          // Ignore
        }
      }

      copyBtn.classList.add('copied')
      copyBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Copied!</span>
      `
      if (copyTimeout) clearTimeout(copyTimeout)
      copyTimeout = setTimeout(() => {
        copyBtn.classList.remove('copied')
        copyBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy Value</span>
        `
      }, 1800)
    }

    copyBtn.onclick = triggerCopy

    const closeBtn = document.createElement('button')
    closeBtn.className = 'vs-graph-modal-btn close'
    closeBtn.type = 'button'
    closeBtn.innerText = '✕ Close'

    const closeModal = () => {
      backdrop.remove()
      document.removeEventListener('keydown', onKeyDown)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModal()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    closeBtn.onclick = closeModal

    actionsEl.appendChild(copyBtn)
    actionsEl.appendChild(closeBtn)

    header.appendChild(titleEl)
    header.appendChild(actionsEl)

    const bodyWrapper = document.createElement('div')
    bodyWrapper.className = 'vs-graph-modal-body-wrapper'

    const body = document.createElement('pre')
    body.className = 'vs-graph-modal-body'
    body.innerText = textToDisplay

    bodyWrapper.appendChild(body)

    modal.appendChild(header)
    modal.appendChild(bodyWrapper)
    backdrop.appendChild(modal)

    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeModal()
    }
    document.body.appendChild(backdrop)
  }

  // Injects the "Graph" tab into [data-testid="workflow-view-tabs"]
  function ensureTabButton(): void {
    const tabsContainer = document.querySelector('[data-testid="workflow-view-tabs"]')
    if (!tabsContainer) return

    // Dynamically retrieve Emotion class from sibling buttons to match 100%
    const siblingBtn =
      tabsContainer.querySelector<HTMLButtonElement>('button[data-testid="workflow-flow-view-tab"]') ||
      tabsContainer.querySelector<HTMLButtonElement>('button')
    const emotionClass =
      Array.from(siblingBtn?.classList || []).find((c) => c.startsWith('css-')) || 'css-1yn0bbm'

    // Convert previous last button to middle button
    const logBtn = tabsContainer.querySelector<HTMLButtonElement>('[data-testid="workflow-log-view-tab"]')
    if (logBtn) {
      logBtn.classList.remove('MuiToggleButtonGroup-lastButton')
      logBtn.classList.add('MuiToggleButtonGroup-middleButton')
      logBtn.style.borderRadius = '0px'
    }

    let graphBtn = tabsContainer.querySelector(`[data-testid="${TAB_BUTTON_TESTID}"]`) as HTMLButtonElement | null
    if (!graphBtn) {
      const span = document.createElement('span')
      span.className = 'vs-graph-tab-wrapper'
      span.setAttribute('aria-label', 'View dependency graph with inputs and outputs.')

      graphBtn = document.createElement('button')
      graphBtn.className = `MuiButtonBase-root MuiToggleButtonGroup-grouped MuiToggleButtonGroup-groupedHorizontal MuiToggleButton-root MuiToggleButton-sizeSmall MuiToggleButton-standard MuiToggleButtonGroup-lastButton ${emotionClass}`
      graphBtn.tabIndex = 0
      graphBtn.type = 'button'
      graphBtn.value = 'graph'
      graphBtn.setAttribute('aria-pressed', isGraphActive ? 'true' : 'false')
      if (isGraphActive) graphBtn.classList.add('Mui-selected')
      graphBtn.setAttribute('data-testid', TAB_BUTTON_TESTID)
      graphBtn.innerText = 'Graph'
      graphBtn.style.borderRadius = '0px 4px 4px 0px'

      span.appendChild(graphBtn)

      const onEnter = () => {
        clearTimeout(tabTooltipTimer)
        tabTooltipTimer = setTimeout(() => {
          showTabTooltip(graphBtn!, 'View dependency graph with inputs and outputs.')
        }, 100)
      }
      const onLeave = () => {
        hideTabTooltip()
      }

      span.addEventListener('mouseenter', onEnter)
      span.addEventListener('mouseleave', onLeave)
      graphBtn.addEventListener('mouseenter', onEnter)
      graphBtn.addEventListener('mouseleave', onLeave)

      const handleTabClick = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        hideTabTooltip()
        void open()
      }
      span.addEventListener('click', handleTabClick)
      graphBtn.addEventListener('click', handleTabClick)

      tabsContainer.appendChild(span)
    } else {
      // Sync classes and border radius
      if (!graphBtn.classList.contains(emotionClass)) {
        Array.from(graphBtn.classList)
          .filter((c) => c.startsWith('css-') && c !== emotionClass)
          .forEach((c) => graphBtn!.classList.remove(c))
        graphBtn.classList.add(emotionClass)
      }
      graphBtn.classList.add('MuiToggleButtonGroup-lastButton')
      graphBtn.style.borderRadius = '0px 4px 4px 0px'
    }

    updateGraphTheme()

    // Attach listeners on other buttons to close graph view when clicked
    const otherButtons = tabsContainer.querySelectorAll<HTMLButtonElement>(
      'button[value="flow"], button[value="preview"], button[value="log"]'
    )
    otherButtons.forEach((btn) => {
      if (!btn.hasAttribute('data-vs-graph-listener')) {
        btn.setAttribute('data-vs-graph-listener', 'true')
        btn.addEventListener('click', () => {
          if (isGraphActive) {
            close()
          }
        })
      }
    })
  }

  function updateTabButtonsState(): void {
    const tabsContainer = document.querySelector('[data-testid="workflow-view-tabs"]')
    if (!tabsContainer) return

    const graphBtn = tabsContainer.querySelector(`[data-testid="${TAB_BUTTON_TESTID}"]`) as HTMLButtonElement | null
    const flowBtn = tabsContainer.querySelector('[data-testid="workflow-flow-view-tab"]') as HTMLButtonElement | null
    const previewBtn = tabsContainer.querySelector('[data-testid="workflow-preview-view-tab"]') as HTMLButtonElement | null
    const logBtn = tabsContainer.querySelector('[data-testid="workflow-log-view-tab"]') as HTMLButtonElement | null

    if (isGraphActive) {
      graphBtn?.classList.add('Mui-selected')
      graphBtn?.setAttribute('aria-pressed', 'true')
      flowBtn?.classList.remove('Mui-selected')
      flowBtn?.setAttribute('aria-pressed', 'false')
      previewBtn?.classList.remove('Mui-selected')
      previewBtn?.setAttribute('aria-pressed', 'false')
      logBtn?.classList.remove('Mui-selected')
      logBtn?.setAttribute('aria-pressed', 'false')
    } else {
      graphBtn?.classList.remove('Mui-selected')
      graphBtn?.setAttribute('aria-pressed', 'false')
    }
    updateGraphTheme()
  }

  async function open(): Promise<void> {
    isGraphActive = true
    document.body.classList.add('vs-graph-active')
    ensureLogsDrawerZIndex()
    updateTabButtonsState()
    updateGraphTheme()

    const nativeZoomP = document.querySelector('[data-testid="zoom-controls"] p')
    if (nativeZoomP && !savedNativeZoomText) {
      savedNativeZoomText = nativeZoomP.textContent || ''
    }

    const flowPageBox = document.getElementById('flow-page-box')
    const contentBox = flowPageBox?.children[1] as HTMLElement | null
    if (!contentBox) return

    if (!overlayEl) {
      overlayEl = document.createElement('div')
      overlayEl.id = OVERLAY_ID
      contentBox.appendChild(overlayEl)
    }
    overlayEl.style.display = 'flex'

    overlayEl.innerHTML = `
      <div class="vs-graph-canvas-bg"></div>
      <div class="vs-graph-viewport" style="display:flex;align-items:center;justify-content:center;">
        <span style="color:#8b949e;font-size:13px;">Analyzing flow dependencies...</span>
      </div>
    `

    const data = await bridge.getFlowGraphData()
    if (!isGraphActive) return

    if (!data) {
      overlayEl.innerHTML = `
        <div class="vs-graph-canvas-bg"></div>
        <div class="vs-graph-top-bar">
          <div class="vs-graph-top-left"></div>
          <div class="vs-graph-top-right">
            <button class="vs-graph-back-btn" id="vs-graph-err-close">✕ Back to Flow</button>
          </div>
        </div>
        <div class="vs-graph-viewport" style="display:flex;align-items:center;justify-content:center;color:#ef4444;font-size:13px;">
          Unable to load workflow graph data. Try reloading the page.
        </div>
      `
      overlayEl.querySelector('#vs-graph-err-close')?.addEventListener('click', close)
      return
    }

    currentGraphData = data
    lastFlowHitId = new URLSearchParams(window.location.search).get('flowhitid') || ''
    const initDrawer = getLogsHistoryDrawer()
    lastDrawerOpen = !!initDrawer

    renderView()
    requestAnimationFrame(() => {
      fitView()
    })
  }

  function close(): void {
    isGraphActive = false
    unlockActivePaths(true)
    hoveredConn = null
    hoveredKeyInfo = null
    document.body.classList.remove('vs-graph-active')
    resetLogsDrawerZIndex()
    updateTabButtonsState()
    if (overlayEl) {
      overlayEl.style.display = 'none'
    }
    hideTooltip()
    hideTabTooltip()

    if (savedNativeZoomText) {
      const nativeZoomP = document.querySelector('[data-testid="zoom-controls"] p')
      if (nativeZoomP) {
        nativeZoomP.textContent = savedNativeZoomText
      }
    }

    // Reselect Flow tab if none is selected
    const flowBtn = document.querySelector('[data-testid="workflow-flow-view-tab"]') as HTMLButtonElement | null
    if (flowBtn && !document.querySelector('.MuiToggleButtonGroup-root .Mui-selected')) {
      flowBtn.classList.add('Mui-selected')
      flowBtn.setAttribute('aria-pressed', 'true')
    }
  }

  function renderView(): void {
    if (!overlayEl || !currentGraphData) return
    ensureLogsDrawerZIndex()

    const { summary } = currentGraphData

    overlayEl.innerHTML = `
      <div class="vs-graph-canvas-bg"></div>

      <!-- Top Floating Controls -->
      <div class="vs-graph-top-bar">
        <div class="vs-graph-top-left"></div>

        <div class="vs-graph-top-center">
          <div class="vs-graph-filter-group" role="group">
            <button class="vs-graph-filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
              All (${summary.totalSteps})
            </button>
            <button class="vs-graph-filter-btn ${currentFilter === 'dependent' ? 'active' : ''}" data-filter="dependent">
              Dependent (${summary.dependentSteps})
            </button>
            ${
              summary.independentSteps > 0
                ? `<button class="vs-graph-filter-btn ${currentFilter === 'independent' ? 'active' : ''}" data-filter="independent">
                    Independent (${summary.independentSteps})
                  </button>`
                : ''
            }
          </div>
        </div>

        <div class="vs-graph-top-right">
          <button class="vs-graph-back-btn" id="vs-graph-close">
            ✕ Back to Flow
          </button>
        </div>
      </div>

      <!-- Canvas Viewport -->
      <div class="vs-graph-viewport" id="vs-graph-viewport">
        <div class="vs-graph-transform-layer" id="vs-graph-transform-layer">
          <svg class="vs-graph-svg" id="vs-graph-svg"></svg>
          <div class="vs-graph-nodes-layer" id="vs-graph-nodes-layer"></div>
        </div>
      </div>

      <!-- Floating Bottom Zoom & Notes Capsule (native viaSocket styling) -->
      <div class="vs-graph-bottom-controls">
        <div class="flex items-center gap-1">
          <div role="group" class="MuiButtonGroup-root MuiButtonGroup-pill MuiButtonGroup-horizontal MuiButtonGroup-colorPrimary border border-[var(--col-border)]" data-testid="zoom-controls">
            <!-- Zoom Out -->
            <button class="MuiButtonBase-root MuiButtonGroup-grouped MuiButtonGroup-groupedHorizontal MuiButtonGroup-groupedPill MuiButtonGroup-groupedPillHorizontal MuiButtonGroup-groupedPillPrimary MuiButton-root MuiButton-pill MuiButton-pillPrimary MuiButton-sizeMedium MuiButton-pillSizeMedium MuiButton-colorPrimary !px-2 MuiButtonGroup-firstButton" tabindex="0" type="button" data-testid="zoom-out-button" id="vs-zoom-out" aria-label="Zoom Out" title="Zoom Out">
              <svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14M7 9h5v1H7z"></path></svg>
            </button>

            <!-- Zoom Level % -->
            <p class="MuiTypography-root MuiTypography-body2 vs-graph-zoom-level" id="vs-zoom-level">${Math.round(zoom * 100)}%</p>

            <!-- Zoom In -->
            <button class="MuiButtonBase-root MuiButtonGroup-grouped MuiButtonGroup-groupedHorizontal MuiButtonGroup-groupedPill MuiButtonGroup-groupedPillHorizontal MuiButtonGroup-groupedPillPrimary MuiButton-root MuiButton-pill MuiButton-pillPrimary MuiButton-sizeMedium MuiButton-pillSizeMedium MuiButton-colorPrimary !px-2 MuiButtonGroup-middleButton" tabindex="0" type="button" data-testid="zoom-in-button" id="vs-zoom-in" aria-label="Zoom In" title="Zoom In">
              <svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"></path><path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2z"></path></svg>
            </button>

            <div class="MuiDivider-root MuiDivider-fullWidth MuiDivider-vertical MuiDivider-flexItem" role="separator" aria-orientation="vertical"></div>

            <!-- Fit to Screen / Zoom -->
            <button class="MuiButtonBase-root MuiButtonGroup-grouped MuiButtonGroup-groupedHorizontal MuiButtonGroup-groupedPill MuiButtonGroup-groupedPillHorizontal MuiButtonGroup-groupedPillPrimary MuiButton-root MuiButton-pill MuiButton-pillPrimary MuiButton-sizeMedium MuiButton-pillSizeMedium MuiButton-colorPrimary !px-2 MuiButtonGroup-middleButton" tabindex="0" type="button" data-testid="zoom-fit-button" id="vs-zoom-fit" aria-label="Fit to Screen" title="Fit to Screen">
              <svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor;"><path d="M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3zM18 8H6v8h12z"></path></svg>
            </button>

            <div class="MuiDivider-root MuiDivider-fullWidth MuiDivider-vertical MuiDivider-flexItem" role="separator" aria-orientation="vertical"></div>

            <!-- Notes / Flow Document -->
            <button class="MuiButtonBase-root MuiButtonGroup-grouped MuiButtonGroup-groupedHorizontal MuiButtonGroup-groupedPill MuiButtonGroup-groupedPillHorizontal MuiButtonGroup-groupedPillPrimary MuiButton-root MuiButton-pill MuiButton-pillPrimary MuiButton-sizeMedium MuiButton-pillSizeMedium MuiButton-colorPrimary !px-2 MuiButtonGroup-lastButton" tabindex="0" type="button" data-testid="flow-document-button" id="vs-notes-btn" aria-label="Flow Document" title="Flow Document / Notes">
              <svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor;"><path d="M14 19.88V22h2.12l5.17-5.17-2.12-2.12zM20 8l-6-6H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H12v-2.95l8-8zm-7 1V3.5L18.5 9zm9.71 5-.71-.71a.996.996 0 0 0-1.41 0l-.71.71L22 16.12l.71-.71c.39-.39.39-1.02 0-1.41"></path></svg>
            </button>
          </div>
        </div>
      </div>
    `

    // Wire listeners
    overlayEl.querySelector('#vs-graph-close')?.addEventListener('click', close)
    overlayEl.querySelectorAll('.vs-graph-filter-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const filter = (e.currentTarget as HTMLElement).getAttribute('data-filter') as 'all' | 'dependent' | 'independent'
        if (filter && filter !== currentFilter) {
          currentFilter = filter
          overlayEl?.querySelectorAll('.vs-graph-filter-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-filter') === filter)
          })
          layoutAndRenderNodes()
        }
      })
    })

    overlayEl.querySelector('#vs-zoom-in')?.addEventListener('click', () => setZoom(zoom * 1.15))
    overlayEl.querySelector('#vs-zoom-out')?.addEventListener('click', () => setZoom(zoom / 1.15))
    overlayEl.querySelector('#vs-zoom-fit')?.addEventListener('click', () => {
      fitView(true)
    })
    overlayEl.querySelector('#vs-notes-btn')?.addEventListener('click', () => {
      const nativeNotes = document.querySelector<HTMLElement>('[data-testid="flow-document-button"]')
      nativeNotes?.click()
    })

    const viewport = overlayEl.querySelector('#vs-graph-viewport') as HTMLElement
    setupCanvasInteractions(viewport)

    layoutAndRenderNodes()
    updateTransform()
  }

  function setZoom(newZoom: number, originX?: number, originY?: number): void {
    const clamped = Math.max(0.35, Math.min(2.0, newZoom))
    if (originX !== undefined && originY !== undefined) {
      const ratio = clamped / zoom
      pan.x = originX - (originX - pan.x) * ratio
      pan.y = originY - (originY - pan.y) * ratio
    } else {
      const viewport = overlayEl?.querySelector('#vs-graph-viewport') as HTMLElement | null
      const rect = viewport ? viewport.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight }
      const cx = rect.width / 2
      const cy = rect.height / 2
      const ratio = clamped / zoom
      pan.x = cx - (cx - pan.x) * ratio
      pan.y = cy - (cy - pan.y) * ratio
    }
    zoom = clamped
    updateTransform()
  }

  function updateTransform(): void {
    const layer = overlayEl?.querySelector('#vs-graph-transform-layer') as HTMLElement | null
    if (layer) {
      layer.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
    }
    const zoomPill = overlayEl?.querySelector('#vs-zoom-level')
    if (zoomPill) {
      zoomPill.textContent = `${Math.round(zoom * 100)}%`
    }
    const nativeZoomP = document.querySelector('[data-testid="zoom-controls"] p')
    if (nativeZoomP && isGraphActive) {
      nativeZoomP.textContent = `${Math.round(zoom * 100)}%`
    }
  }

  function setupCanvasInteractions(viewport: HTMLElement): void {
    viewport.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement | null
      if (
        !target ||
        target.closest('.vs-graph-card') ||
        target.closest('.vs-graph-independent-lane') ||
        target.closest('.vs-graph-modal-backdrop') ||
        target.closest('button') ||
        target.closest('.vs-graph-top-bar')
      ) return
      isDragging = true
      dragStart = { x: e.clientX, y: e.clientY }
      panStart = { x: pan.x, y: pan.y }
      viewport.classList.add('is-panning')
    })

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return
      pan.x = panStart.x + (e.clientX - dragStart.x)
      pan.y = panStart.y + (e.clientY - dragStart.y)
      updateTransform()
    })

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false
        viewport.classList.remove('is-panning')
      }
    })

    viewport.addEventListener('mousemove', (e) => {
      if (lockedState) return
      const target = e.target as HTMLElement | SVGElement | null
      const isOverPath = Boolean(target?.closest?.('.vs-graph-path, .vs-graph-path-hitarea'))
      if (!isOverPath) {
        if (hoveredConn) {
          hoveredConn = null
          hideTooltip()
          clearHighlights()
        }
      }
    })

    viewport.addEventListener('mouseleave', () => {
      if (lockedState) return
      hoveredConn = null
      hoveredKeyInfo = null
      hideTooltip()
      clearHighlights()
    })

    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const rect = viewport.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const factor = Math.exp(-e.deltaY * 0.0018)
        setZoom(zoom * factor, mouseX, mouseY)
      },
      { passive: false }
    )

    viewport.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      if (
        lockedState &&
        target &&
        !target.closest('.vs-graph-card') &&
        !target.closest('.vs-graph-lock-pill') &&
        !target.closest('.vs-graph-modal')
      ) {
        unlockActivePaths(true)
      }
    })
  }

  function animateTransform(durationMs = 250): void {
    const layer = overlayEl?.querySelector('#vs-graph-transform-layer') as HTMLElement | null
    if (!layer) return
    layer.style.transition = `transform ${durationMs}ms cubic-bezier(0.16, 1, 0.3, 1)`
    updateTransform()
    setTimeout(() => {
      if (layer) layer.style.transition = ''
    }, durationMs + 20)
  }

  function ensureLogsDrawerZIndex(): void {
    if (!isGraphActive) return
    const poppers = document.querySelectorAll<HTMLElement>('.MuiPopper-root')
    poppers.forEach((popper) => {
      if (
        popper.querySelector('[data-testid="logs-list-container"]') ||
        popper.querySelector('[data-testid="logs-slider-card"]') ||
        popper.querySelector('input[placeholder*="history" i]') ||
        popper.querySelector('input[placeholder*="search" i]') ||
        popper.classList.contains('z-[50]')
      ) {
        popper.style.setProperty('z-index', '260', 'important')
      }
    })

    const nativeChipContainer = document.querySelector<HTMLElement>('[data-testid="workflow-navbar-logs-time-chip-container"]')
    if (nativeChipContainer) {
      nativeChipContainer.style.setProperty('z-index', '260', 'important')
    }
  }

  function resetLogsDrawerZIndex(): void {
    const poppers = document.querySelectorAll<HTMLElement>('.MuiPopper-root')
    poppers.forEach((popper) => {
      if (
        popper.querySelector('[data-testid="logs-list-container"]') ||
        popper.querySelector('[data-testid="logs-slider-card"]') ||
        popper.querySelector('input[placeholder*="history" i]') ||
        popper.querySelector('input[placeholder*="search" i]') ||
        popper.classList.contains('z-[50]')
      ) {
        popper.style.removeProperty('z-index')
      }
    })

    const nativeChipContainer = document.querySelector<HTMLElement>('[data-testid="workflow-navbar-logs-time-chip-container"]')
    if (nativeChipContainer) {
      nativeChipContainer.style.removeProperty('z-index')
    }
  }

  function getLogsHistoryDrawer(): HTMLElement | null {
    const container = (document.querySelector('[data-testid="logs-popover-container"]') ||
      document.querySelector('input[placeholder*="History"]')?.closest('.MuiPaper-root, .MuiBox-root, .MuiPopper-root') ||
      document.querySelector('[data-testid="logs-list-container"]')?.closest('.MuiPaper-root, .MuiBox-root, .MuiPopper-root') ||
      document.querySelector('[data-testid="logs-slider-card"]')) as HTMLElement | null

    if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
      return container
    }
    return null
  }

  function fitView(animated = false): void {
    const viewport = overlayEl?.querySelector('#vs-graph-viewport') as HTMLElement | null
    if (!viewport || !currentGraphData) return

    const rect = viewport.getBoundingClientRect()
    const padding = 60

    const cards = Array.from(overlayEl?.querySelectorAll('.vs-graph-card') || [])
    if (cards.length === 0) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const card of cards) {
      const el = card as HTMLElement
      const left = parseFloat(el.style.left) || 0
      const top = parseFloat(el.style.top) || 0
      const width = el.offsetWidth || 330
      const height = el.offsetHeight || 180
      minX = Math.min(minX, left)
      minY = Math.min(minY, top)
      maxX = Math.max(maxX, left + width)
      maxY = Math.max(maxY, top + height)
    }

    const graphWidth = maxX - minX
    const graphHeight = maxY - minY
    if (graphWidth <= 0 || graphHeight <= 0) return

    const historyDrawer = getLogsHistoryDrawer()
    const isHistoryDrawerOpen = !!historyDrawer
    const drawerRight = isHistoryDrawerOpen ? historyDrawer.getBoundingClientRect().right : 0
    const availableLeft = drawerRight > 0 ? drawerRight + 24 : 0
    const availableWidth = Math.max(300, rect.width - availableLeft)

    const scaleX = (availableWidth - padding * 2) / graphWidth
    const scaleY = (rect.height - padding * 2) / graphHeight
    const targetZoom = Math.max(0.4, Math.min(1.0, Math.min(scaleX, scaleY)))

    zoom = targetZoom
    pan.x = availableLeft + (availableWidth - graphWidth * zoom) / 2 - minX * zoom
    pan.y = (rect.height - graphHeight * zoom) / 2 - minY * zoom

    if (animated) {
      animateTransform(250)
    } else {
      updateTransform()
    }
  }

  function layoutAndRenderNodes(): void {
    if (!currentGraphData || !overlayEl) return
    const { trigger, steps } = currentGraphData
    const nodesLayer = overlayEl.querySelector('#vs-graph-nodes-layer') as HTMLElement
    nodesLayer.innerHTML = ''

    if (currentFilter === 'independent' && !steps.some((s) => s.isIndependent)) {
      currentFilter = 'all'
      overlayEl.querySelectorAll('.vs-graph-filter-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-filter') === 'all')
      })
    }

    let visibleSteps = steps
    if (currentFilter === 'dependent') {
      visibleSteps = steps.filter((s) => !s.isIndependent)
    } else if (currentFilter === 'independent') {
      visibleSteps = steps.filter((s) => s.isIndependent)
    }

    const dependentSteps = visibleSteps.filter((s) => !s.isIndependent)
    const independentSteps = visibleSteps.filter((s) => s.isIndependent)

    const COLUMN_WIDTH = 450
    const START_X = 60
    const START_Y = 80
    const CARD_GAP_Y = 32

    const columns: Map<number, FlowGraphNode[]> = new Map()
    if (trigger && currentFilter !== 'independent') {
      columns.set(0, [trigger])
    }

    for (const step of dependentSteps) {
      const col = Math.max(1, step.depth)
      const list = columns.get(col) || []
      list.push(step)
      columns.set(col, list)
    }

    let maxGraphY = START_Y

    for (const [colIndex, colNodes] of columns.entries()) {
      const colX = START_X + colIndex * COLUMN_WIDTH
      let currentY = START_Y

      for (const node of colNodes) {
        const card = createNodeCard(node)
        card.setAttribute('data-col', String(colIndex))
        card.style.left = `${colX}px`
        card.style.top = `${currentY}px`
        nodesLayer.appendChild(card)

        const inHeight = node.inputs.length > 0 ? 25 + node.inputs.length * 27 : 0
        const outHeight = node.outputs.length > 0 ? 25 + node.outputs.length * 27 : 0
        const estimatedHeight = Math.max(90, 48 + inHeight + outHeight)
        currentY += estimatedHeight + CARD_GAP_Y
      }

      maxGraphY = Math.max(maxGraphY, currentY)
    }

    if (independentSteps.length > 0) {
      const indepSectionY = maxGraphY + 40
      const sectionWidth = Math.max(750, independentSteps.length * (COLUMN_WIDTH - 50) + 40)
      const sectionHeight = 320

      const lane = document.createElement('div')
      lane.className = 'vs-graph-independent-lane'
      lane.style.left = `${START_X}px`
      lane.style.top = `${indepSectionY}px`
      lane.style.width = `${sectionWidth}px`
      lane.style.height = `${sectionHeight}px`

      const label = document.createElement('div')
      label.className = 'vs-graph-lane-header'
      label.innerHTML = `<span>Independent Steps (Run standalone / 0 upstream dependencies)</span>`
      lane.appendChild(label)
      nodesLayer.appendChild(lane)

      let indepX = START_X + 24
      const indepY = indepSectionY + 26
      for (const step of independentSteps) {
        const card = createNodeCard(step)
        card.setAttribute('data-independent', 'true')
        card.style.left = `${indepX}px`
        card.style.top = `${indepY}px`
        nodesLayer.appendChild(card)
        indepX += 380
      }
    }

    reflowNodePositions()
  }

  function reflowNodePositions(): void {
    if (!overlayEl || !currentGraphData) return
    const nodesLayer = overlayEl.querySelector('#vs-graph-nodes-layer') as HTMLElement | null
    if (!nodesLayer) return

    const colCardsMap = new Map<number, HTMLElement[]>()
    const cards = Array.from(nodesLayer.querySelectorAll<HTMLElement>('.vs-graph-card[data-col]'))
    for (const card of cards) {
      const col = parseInt(card.getAttribute('data-col') || '0', 10)
      if (!colCardsMap.has(col)) colCardsMap.set(col, [])
      colCardsMap.get(col)!.push(card)
    }

    let maxGraphY = 80

    for (const [, colCards] of colCardsMap.entries()) {
      let currentY = 80
      for (const card of colCards) {
        card.style.top = `${currentY}px`
        currentY += card.offsetHeight + 32
      }
      maxGraphY = Math.max(maxGraphY, currentY)
    }

    const multiSpanCount = currentGraphData.connections.filter((c) => {
      const fromStep = currentGraphData?.steps.find((s) => s.slugName === c.fromSlug)
      const toStep = currentGraphData?.steps.find((s) => s.slugName === c.toSlug)
      return fromStep && toStep && Math.abs(toStep.depth - fromStep.depth) > 1
    }).length
    if (multiSpanCount > 0) {
      maxGraphY += Math.min(180, multiSpanCount * 22 + 40)
    }

    const lane = nodesLayer.querySelector<HTMLElement>('.vs-graph-independent-lane')
    if (lane) {
      const indepSectionY = maxGraphY + 40
      lane.style.top = `${indepSectionY}px`
      const indepCards = Array.from(nodesLayer.querySelectorAll<HTMLElement>('.vs-graph-card[data-independent="true"]'))
      const indepY = indepSectionY + 36
      let maxIndepHeight = 0
      for (const card of indepCards) {
        card.style.top = `${indepY}px`
        maxIndepHeight = Math.max(maxIndepHeight, card.offsetHeight)
      }
      lane.style.height = `${Math.max(260, maxIndepHeight + 56)}px`
    }

    requestAnimationFrame(() => {
      renderConnections()
    })
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function formatJsonCrackValue(rawVal: unknown): { html: string; text: string } {
    if (rawVal === null) {
      return { html: '<span class="vs-val-null">null</span>', text: 'null' }
    }
    if (rawVal === undefined) {
      return { html: '<span class="vs-val-null">undefined</span>', text: 'undefined' }
    }
    if (typeof rawVal === 'boolean') {
      return {
        html: `<span class="vs-val-bool">${rawVal}</span>`,
        text: String(rawVal),
      }
    }
    if (typeof rawVal === 'number') {
      return {
        html: `<span class="vs-val-num">${rawVal}</span>`,
        text: String(rawVal),
      }
    }
    if (Array.isArray(rawVal)) {
      const len = rawVal.length
      const isEmpty = len === 0
      return {
        html: `<span class="vs-val-badge vs-val-array ${isEmpty ? '' : 'expandable'}">[${len} ${len === 1 ? 'item' : 'items'}]</span>`,
        text: `[${len} items]`,
      }
    }
    if (typeof rawVal === 'object') {
      const keys = Object.keys(rawVal as Record<string, unknown>)
      const len = keys.length
      const isEmpty = len === 0
      return {
        html: `<span class="vs-val-badge vs-val-obj ${isEmpty ? '' : 'expandable'}">{${len} ${len === 1 ? 'key' : 'keys'}}</span>`,
        text: `{${len} keys}`,
      }
    }

    const str = String(rawVal)
    const trimmed = str.trim()

    // Hex color swatch (signature JSON Crack feature)
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
      return {
        html: `<span class="vs-val-swatch" style="background-color:${escapeHtml(trimmed)};"></span><span class="vs-val-str">"${escapeHtml(trimmed)}"</span>`,
        text: trimmed,
      }
    }
    // Number encoded as string
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed.length <= 12) {
      return {
        html: `<span class="vs-val-num">${escapeHtml(trimmed)}</span>`,
        text: trimmed,
      }
    }
    if (trimmed === 'true' || trimmed === 'false') {
      return {
        html: `<span class="vs-val-bool">${trimmed}</span>`,
        text: trimmed,
      }
    }
    if (trimmed === 'null') {
      return {
        html: '<span class="vs-val-null">null</span>',
        text: 'null',
      }
    }
    // Check if JSON object/array string
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed)
        return formatJsonCrackValue(parsed)
      } catch {
        // keep as string
      }
    }

    const truncated = trimmed.length > 28 ? trimmed.slice(0, 26) + '…' : trimmed
    return {
      html: `<span class="vs-val-str">"${escapeHtml(truncated)}"</span>`,
      text: str,
    }
  }

  interface ComplexValueInfo {
    isComplex: boolean
    isArray: boolean
    data: unknown
    count: number
  }

  function parseComplexValue(val: unknown): ComplexValueInfo {
    let target = val
    if (typeof target === 'string') {
      const trimmed = target.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          target = JSON.parse(trimmed)
        } catch {
          // not valid json
        }
      }
    }
    if (target !== null && typeof target === 'object') {
      if (Array.isArray(target)) {
        return { isComplex: true, isArray: true, data: target, count: target.length }
      }
      const keys = Object.keys(target as Record<string, unknown>)
      return { isComplex: true, isArray: false, data: target, count: keys.length }
    }
    return { isComplex: false, isArray: false, data: target, count: 0 }
  }

  function createPropertyTreeItem(params: {
    key: string
    value: unknown
    node: FlowGraphNode
    isInput: boolean
    depth: number
    portId?: string
    expression?: string
    isIndex?: boolean
    parentPath?: string
  }): HTMLElement {
    const { key, value, node, isInput, depth, portId, expression, isIndex, parentPath } = params
    const itemWrapper = document.createElement('div')
    itemWrapper.className = depth === 0 ? 'vs-graph-tree-item' : 'vs-graph-nested-tree-item'

    const currentPath = parentPath ? (isIndex ? `${parentPath}[${key}]` : `${parentPath}.${key}`) : key

    const row = document.createElement('div')
    row.className = depth === 0 ? 'vs-graph-row' : 'vs-graph-nested-row'
    if (portId) {
      row.setAttribute('data-port-id', portId)
    }
    row.setAttribute('data-node-id', node.id)

    const complex = parseComplexValue(value)
    const canExpand = complex.isComplex && complex.count > 0
    const pathKey = `${node.id}:${isInput ? 'in' : 'out'}:${currentPath}`
    let isExpanded = canExpand && expandedPaths.has(pathKey)

    const formatted = formatJsonCrackValue(complex.isComplex ? complex.data : value)
    const detailText = expression ? `${expression} = ${formatted.text}` : `${currentPath} = ${formatted.text}`

    // Left port dot (if input and has connection)
    if (isInput && portId) {
      const hasIncomingConn = currentGraphData?.connections.some((c) => c.toPortId === portId)
      if (hasIncomingConn) {
        const dot = document.createElement('div')
        dot.className = 'vs-graph-port-dot port-in'
        dot.setAttribute('data-port-id', portId)
        row.appendChild(dot)
      }
    }

    // Expand toggle button or placeholder spacer
    let expandBtn: HTMLButtonElement | null = null
    if (canExpand) {
      expandBtn = document.createElement('button')
      expandBtn.className = 'vs-graph-expand-btn'
      expandBtn.type = 'button'
      expandBtn.textContent = isExpanded ? '−' : '+'
      expandBtn.setAttribute('aria-label', `Toggle ${key}`)
      row.appendChild(expandBtn)
    } else if (depth > 0) {
      const placeholder = document.createElement('div')
      placeholder.className = 'vs-graph-expand-placeholder'
      row.appendChild(placeholder)
    }

    // Key element
    const keyEl = document.createElement('div')
    keyEl.className = `vs-graph-row-key ${isIndex ? 'vs-row-index' : ''}`
    keyEl.textContent = isIndex ? `[${key}]` : key

    // Colon
    const colonEl = document.createElement('div')
    colonEl.className = 'vs-graph-row-colon'
    colonEl.textContent = ':'

    // Value element
    const valEl = document.createElement('div')
    valEl.className = 'vs-graph-row-val'
    valEl.innerHTML = formatted.html

    // Inspect button (opens full JSON modal)
    const inspectBtn = document.createElement('button')
    inspectBtn.className = 'vs-graph-row-inspect-btn'
    inspectBtn.type = 'button'
    inspectBtn.setAttribute('aria-label', 'Inspect in modal')
    inspectBtn.innerHTML = '↗'
    inspectBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      showDetailsModal(`${node.title} → ${currentPath}`, complex.isComplex ? complex.data : value)
    })
    valEl.appendChild(inspectBtn)

    row.appendChild(keyEl)
    row.appendChild(colonEl)
    row.appendChild(valEl)

    // Right port dot (if output and has connection)
    if (!isInput && portId) {
      const hasOutgoingConn = currentGraphData?.connections.some((c) => c.fromPortId === portId)
      if (hasOutgoingConn) {
        const dot = document.createElement('div')
        dot.className = 'vs-graph-port-dot port-out'
        dot.setAttribute('data-port-id', portId)
        row.appendChild(dot)
      }
    }

    itemWrapper.appendChild(row)

    // Nested children container
    let nestedContainer: HTMLElement | null = null
    if (canExpand) {
      nestedContainer = document.createElement('div')
      nestedContainer.className = 'vs-graph-nested-container'
      nestedContainer.style.display = isExpanded ? 'flex' : 'none'
      itemWrapper.appendChild(nestedContainer)

      let renderedChildren = false
      let visibleCount = 8

      const populateChildren = () => {
        if (!nestedContainer) return
        nestedContainer.innerHTML = ''

        if (complex.isArray) {
          const arr = complex.data as unknown[]
          const count = arr.length
          const limit = Math.min(visibleCount, count)

          for (let i = 0; i < limit; i++) {
            const childItem = createPropertyTreeItem({
              key: String(i),
              value: arr[i],
              node,
              isInput,
              depth: depth + 1,
              isIndex: true,
              parentPath: currentPath,
            })
            nestedContainer.appendChild(childItem)
          }

          if (count > limit) {
            const showMore = document.createElement('div')
            showMore.className = 'vs-graph-show-more-row'
            showMore.textContent = `+ Show ${count - limit} more items (${count} total)`
            showMore.addEventListener('click', (e) => {
              e.stopPropagation()
              visibleCount += 20
              populateChildren()
              reflowNodePositions()
            })
            nestedContainer.appendChild(showMore)
          } else if (count > 8) {
            const showLess = document.createElement('div')
            showLess.className = 'vs-graph-show-more-row'
            showLess.textContent = '− Show less'
            showLess.addEventListener('click', (e) => {
              e.stopPropagation()
              visibleCount = 8
              populateChildren()
              reflowNodePositions()
            })
            nestedContainer.appendChild(showLess)
          }
        } else {
          // Object
          const objData = complex.data as Record<string, unknown>
          const entries = Object.entries(objData)

          for (const [childKey, childVal] of entries) {
            const childItem = createPropertyTreeItem({
              key: childKey,
              value: childVal,
              node,
              isInput,
              depth: depth + 1,
              isIndex: false,
              parentPath: currentPath,
            })
            nestedContainer.appendChild(childItem)
          }
        }
        renderedChildren = true
      }

      if (isExpanded) {
        populateChildren()
      }

      const toggleExpand = () => {
        isExpanded = !isExpanded
        if (isExpanded) {
          expandedPaths.add(pathKey)
          if (expandBtn) {
            expandBtn.textContent = '−'
          }
          nestedContainer!.style.display = 'flex'
          if (!renderedChildren) {
            populateChildren()
          }
        } else {
          expandedPaths.delete(pathKey)
          if (expandBtn) {
            expandBtn.textContent = '+'
          }
          nestedContainer!.style.display = 'none'
        }
        reflowNodePositions()
      }

      if (expandBtn) {
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          toggleExpand()
        })
      }

      const badge = valEl.querySelector('.vs-val-badge.expandable')
      if (badge) {
        badge.addEventListener('click', (e) => {
          e.stopPropagation()
          toggleExpand()
        })
      }

      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.vs-graph-row-inspect-btn')) return
        toggleExpand()
      })
    } else {
      // Not expandable: clicking opens modal
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.vs-graph-row-inspect-btn')) return
        e.stopPropagation()
        showDetailsModal(`${node.title} → ${currentPath}`, complex.isComplex ? complex.data : value)
      })
    }

    // Hover highlights for port curves, unified tooltip, and key locking
    const onRowEnter = (e: MouseEvent) => {
      if (lockedState) return
      if (portId) {
        highlightPortAndCurves(portId, isInput ? 'input' : 'output', key, node.title || node.slugName)
      }
      const conns = portId
        ? currentGraphData?.connections.filter((c) =>
            isInput ? c.toPortId === portId : c.fromPortId === portId
          ) || []
        : []
      if (conns.length > 0 && portId) {
        hoveredKeyInfo = {
          portId,
          type: isInput ? 'input' : 'output',
          keyName: key,
          stepTitle: node.title || node.slugName,
          conns,
        }
        hoveredConn = null
      }
      const tip = `${node.title || node.slugName}.${key}${conns.length > 0 ? ` (${conns.length} ${conns.length === 1 ? 'connection' : 'connections'})` : ''}`
      const shortcut = conns.length > 0
        ? (conns.length === 1 ? 'Space: Lock path • Click to inspect' : `Space: Lock all ${conns.length} paths • Click to inspect`)
        : (canExpand ? 'Click to expand/collapse' : 'Click to inspect')
      showTooltip(e.clientX, e.clientY, tip, shortcut, detailText)
    }

    const onRowMove = (e: MouseEvent) => {
      if (lockedState) return
      const conns = portId
        ? currentGraphData?.connections.filter((c) =>
            isInput ? c.toPortId === portId : c.fromPortId === portId
          ) || []
        : []
      const tip = `${node.title || node.slugName}.${key}${conns.length > 0 ? ` (${conns.length} ${conns.length === 1 ? 'connection' : 'connections'})` : ''}`
      const shortcut = conns.length > 0
        ? (conns.length === 1 ? 'Space: Lock path • Click to inspect' : `Space: Lock all ${conns.length} paths • Click to inspect`)
        : (canExpand ? 'Click to expand/collapse' : 'Click to inspect')
      showTooltip(e.clientX, e.clientY, tip, shortcut, detailText)
    }

    const onRowLeave = () => {
      hoveredKeyInfo = null
      hideTooltip()
      if (lockedState) return
      clearHighlights()
    }

    row.addEventListener('mouseenter', onRowEnter)
    row.addEventListener('mousemove', onRowMove)
    row.addEventListener('mouseleave', onRowLeave)

    return itemWrapper
  }

  function selectCard(nodeId: string): void {
    if (!overlayEl) return
    overlayEl.querySelectorAll('.vs-graph-card').forEach((c) => {
      if (c.getAttribute('data-node-id') === nodeId) {
        c.classList.add('selected')
      } else {
        c.classList.remove('selected')
      }
    })
  }

  function openStepEditor(node: FlowGraphNode): void {
    selectCard(node.id)

    if (node.type === 'trigger' || node.id === 'webhook') {
      const triggerEl =
        document.querySelector<HTMLElement>('[data-testid="inflow-node-webhook"]') ||
        document.querySelector<HTMLElement>('[id*="webhook" i]')
      if (triggerEl) {
        const area = triggerEl.querySelector<HTMLElement>('.MuiCardActionArea-root') || triggerEl
        area.click()
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.set('stepId', 'SET_TRIGGER')
      url.searchParams.set('slugName', 'webhook')
      window.history.pushState({}, '', url.toString())
      window.dispatchEvent(new PopStateEvent('popstate'))
      return
    }

    const nativeNode =
      document.querySelector<HTMLElement>(`[data-testid="step-node-${node.id}"]`) ||
      document.getElementById(node.id) ||
      document.querySelector<HTMLElement>(`[id*="${node.id}"]`)
    if (nativeNode) {
      const target = nativeNode.querySelector<HTMLElement>('.MuiCardActionArea-root') || nativeNode
      target.click()
      return
    }

    const url = new URL(window.location.href)
    url.searchParams.set('slugName', node.id)
    window.history.pushState({}, '', url.toString())
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  function openStepMenu(node: FlowGraphNode, menuBtn: HTMLElement): void {
    const nativeBtn =
      document.querySelector<HTMLElement>(`#${node.id}actionbutton button`) ||
      document.querySelector<HTMLElement>(`[data-testid="step-node-${node.id}"] button[aria-label="More actions"]`) ||
      document.querySelector<HTMLElement>(`#${node.id} button[aria-label="More actions"]`)

    if (nativeBtn) {
      nativeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      nativeBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      nativeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

      const positionMenu = () => {
        const menu = document.querySelector<HTMLElement>('.MuiMenu-root, .MuiPopover-root[role="presentation"]')
        const menuPaper = menu?.querySelector<HTMLElement>('.MuiPaper-root')
        if (menuPaper && menuBtn) {
          const rect = menuBtn.getBoundingClientRect()
          menuPaper.style.position = 'fixed'
          menuPaper.style.top = `${rect.bottom + 4}px`
          menuPaper.style.left = `${Math.max(10, rect.right - menuPaper.offsetWidth)}px`
          menuPaper.style.zIndex = '1350'
        }
      }

      requestAnimationFrame(positionMenu)
      setTimeout(positionMenu, 60)
      return
    }

    // Fallback if trigger or no native button: open editor
    openStepEditor(node)
  }

  function createNodeCard(node: FlowGraphNode): HTMLElement {
    const card = document.createElement('div')
    card.className = 'MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation1 MuiCard-root vs-graph-card'
    card.setAttribute('data-node-id', node.id)
    if (node.stepStatus) {
      card.setAttribute('data-status', node.stepStatus)
    }

    // Resolved icon URL matching native viaSocket
    let iconSrc = node.iconUrl
    if (node.type === 'trigger') {
      iconSrc = WEBHOOK_ICON_URL
    } else if (node.type === 'function') {
      iconSrc = JS_ICON_URL
    } else if (!iconSrc) {
      iconSrc = JS_ICON_URL
    }

    const isWebhook = node.type === 'trigger'
    const isDelayNode = node.type === 'delay' || node.slugName.toLowerCase() === 'delay'
    const subtitle = isWebhook
      ? 'https://flow.sokt.io/func/scriwknFmRIS'
      : isDelayNode
        ? 'Delay • Pauses workflow before next step'
        : ''

    const statusChipHtml =
      node.statusLabel && node.stepStatus && node.stepStatus !== 'active'
        ? `<span class="vs-graph-status-chip ${node.stepStatus}" title="${escapeHtml(node.statusLabel)}">${escapeHtml(node.statusLabel)}</span>`
        : ''

    card.innerHTML = `
      <div class="vs-graph-card-header">
        <div class="vs-graph-card-avatar" title="Click to edit ${escapeHtml(node.title)}">
          <img alt="" src="${iconSrc}" />
        </div>
        <div class="vs-graph-card-title-box" title="Click to edit ${escapeHtml(node.title)}">
          <div class="vs-graph-card-title-row">
            <p class="vs-graph-card-title">${escapeHtml(node.title)}</p>
            ${statusChipHtml}
          </div>
          ${subtitle ? `<p class="vs-graph-card-url">${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <div class="vs-graph-card-actions">
          ${node.isIndependent ? `<span class="vs-graph-card-badge indep">Independent</span>` : ''}
          <button class="vs-graph-edit-btn" aria-label="Edit step" title="Edit step" type="button">
            <svg class="MuiSvgIcon-root" viewBox="0 0 24 24" style="width:15px;height:15px;fill:currentColor;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>
          </button>
          <button class="vs-graph-menu-btn" aria-label="More actions" title="More actions" type="button">
            <svg class="MuiSvgIcon-root" viewBox="0 0 24 24" style="width:17px;height:17px;fill:currentColor;"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2m0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2m0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2"></path></svg>
          </button>
        </div>
      </div>
    `

    const editBtn = card.querySelector<HTMLButtonElement>('.vs-graph-edit-btn')
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        openStepEditor(node)
      })
    }

    const menuBtn = card.querySelector<HTMLButtonElement>('.vs-graph-menu-btn')
    if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        openStepMenu(node, menuBtn)
      })
    }

    const titleBox = card.querySelector<HTMLElement>('.vs-graph-card-title-box')
    if (titleBox) {
      titleBox.style.cursor = 'pointer'
      titleBox.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return
        openStepEditor(node)
      })
    }

    const avatar = card.querySelector<HTMLElement>('.vs-graph-card-avatar')
    if (avatar) {
      avatar.style.cursor = 'pointer'
      avatar.addEventListener('click', () => {
        openStepEditor(node)
      })
    }

    // Inputs (With) section - structured table rows
    if (node.inputs.length > 0) {
      const inSection = document.createElement('div')
      inSection.className = 'vs-graph-section'

      const inKey = `${node.id}:inputs`
      const isInputsCollapsed = collapsedSections.has(inKey)
      if (isInputsCollapsed) {
        inSection.classList.add('collapsed')
      }

      const secHeader = document.createElement('div')
      secHeader.className = 'vs-graph-section-header'
      secHeader.setAttribute('role', 'button')
      secHeader.setAttribute('aria-expanded', isInputsCollapsed ? 'false' : 'true')
      secHeader.setAttribute('title', 'Click to collapse / expand inputs')
      secHeader.innerHTML = `
        <div class="vs-graph-section-header-left">
          <span class="vs-graph-section-chevron">▾</span>
          <span class="vs-graph-section-tag">With / Inputs</span>
        </div>
        <span class="vs-graph-section-count">${node.inputs.length}</span>
      `
      secHeader.addEventListener('click', (e) => {
        e.stopPropagation()
        const isCollapsed = inSection.classList.toggle('collapsed')
        secHeader.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')
        if (isCollapsed) collapsedSections.add(inKey)
        else collapsedSections.delete(inKey)
        reflowNodePositions()
      })
      inSection.appendChild(secHeader)

      const rowsList = document.createElement('div')
      rowsList.className = 'vs-graph-rows-list'

      for (const input of node.inputs) {
        const item = createPropertyTreeItem({
          key: input.key,
          value: input.value,
          node,
          isInput: true,
          depth: 0,
          portId: input.id,
          expression: input.expression,
        })
        rowsList.appendChild(item)
      }

      inSection.appendChild(rowsList)
      card.appendChild(inSection)
    }

    // Outputs section - structured table rows
    if (node.outputs.length > 0) {
      const outSection = document.createElement('div')
      outSection.className = 'vs-graph-section output-section'

      const outKey = `${node.id}:outputs`
      const isOutputsCollapsed = collapsedSections.has(outKey)
      if (isOutputsCollapsed) {
        outSection.classList.add('collapsed')
      }

      const secHeader = document.createElement('div')
      secHeader.className = 'vs-graph-section-header'
      secHeader.setAttribute('role', 'button')
      secHeader.setAttribute('aria-expanded', isOutputsCollapsed ? 'false' : 'true')
      secHeader.setAttribute('title', 'Click to collapse / expand outputs')
      secHeader.innerHTML = `
        <div class="vs-graph-section-header-left">
          <span class="vs-graph-section-chevron">▾</span>
          <span class="vs-graph-section-tag">Outputs</span>
        </div>
        <span class="vs-graph-section-count">${node.outputs.length}</span>
      `
      secHeader.addEventListener('click', (e) => {
        e.stopPropagation()
        const isCollapsed = outSection.classList.toggle('collapsed')
        secHeader.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')
        if (isCollapsed) collapsedSections.add(outKey)
        else collapsedSections.delete(outKey)
        reflowNodePositions()
      })
      outSection.appendChild(secHeader)

      const rowsList = document.createElement('div')
      rowsList.className = 'vs-graph-rows-list'

      for (const output of node.outputs) {
        const item = createPropertyTreeItem({
          key: output.key,
          value: output.value,
          node,
          isInput: false,
          depth: 0,
          portId: output.id,
        })
        rowsList.appendChild(item)
      }

      outSection.appendChild(rowsList)
      card.appendChild(outSection)
    }

    return card
  }

  interface CalculatedConnection {
    conn: FlowGraphConnection
    x1: number
    y1: number
    x2: number
    y2: number
    isSequentialConn: boolean
    isMultiSpan: boolean
    isReverse: boolean
    laneIndex?: number
  }

  interface LockedPathState {
    conns: FlowGraphConnection[]
    title: string
    subtitle?: string
    isKeyLock: boolean
  }

  let lockedState: LockedPathState | null = null
  let hoveredConn: FlowGraphConnection | null = null
  let hoveredKeyInfo: {
    portId: string
    type: 'input' | 'output'
    keyName: string
    stepTitle: string
    conns: FlowGraphConnection[]
  } | null = null

  function highlightActivePath(conn: FlowGraphConnection): void {
    if (!overlayEl) return
    const svg = overlayEl.querySelector('#vs-graph-svg') as SVGElement | null
    if (!svg) return

    svg.classList.add('has-active-connection')
    const path = svg.querySelector(`.vs-graph-path[data-conn-id="${conn.id}"]`) as SVGPathElement | null
    if (path) {
      path.classList.add('highlighted', 'pulse-anim')
    }

    highlightConnectedPorts(conn.fromPortId, conn.toPortId)
    highlightConnectedCards(conn.fromSlug, conn.toSlug)
  }

  function highlightConnectedCards(fromSlug?: string, toSlug?: string): void {
    if (!overlayEl) return
    if (fromSlug) {
      const card = overlayEl.querySelector(`.vs-graph-card[data-node-id="${fromSlug}"]`)
      card?.classList.add('card-connected-highlight', 'card-source-highlight')
    }
    if (toSlug) {
      const card = overlayEl.querySelector(`.vs-graph-card[data-node-id="${toSlug}"]`)
      card?.classList.add('card-connected-highlight', 'card-target-highlight')
    }
  }

  function showLockPill(title: string, subtitle?: string): void {
    if (!overlayEl) return
    let pill = overlayEl.querySelector('#vs-graph-lock-pill') as HTMLElement | null
    if (!pill) {
      pill = document.createElement('div')
      pill.id = 'vs-graph-lock-pill'
      pill.className = 'vs-graph-lock-pill'
      overlayEl.appendChild(pill)
    }

    pill.innerHTML = `
      <span class="vs-lock-icon">🔒</span>
      <span class="vs-lock-text">${escapeHtml(title)}</span>
      ${subtitle ? `<span class="vs-lock-val"> ${escapeHtml(subtitle)}</span>` : ''}
      <span class="vs-lock-hint">Press Space to unlock</span>
      <button class="vs-lock-close" title="Unlock">✕</button>
    `

    pill.querySelector('.vs-lock-close')?.addEventListener('click', (e) => {
      e.stopPropagation()
      unlockActivePaths(true)
    })
  }

  function lockActivePaths(conns: FlowGraphConnection[], title: string, subtitle = '', isKeyLock = false): void {
    unlockActivePaths(false)
    if (!overlayEl || conns.length === 0) return

    lockedState = {
      conns,
      title,
      subtitle,
      isKeyLock,
    }

    const svg = overlayEl.querySelector('#vs-graph-svg') as SVGElement | null
    if (!svg) return

    svg.classList.add('has-active-connection')
    const connIdSet = new Set(conns.map((c) => c.id))

    svg.querySelectorAll<SVGPathElement>('.vs-graph-path').forEach((p) => {
      const connId = p.getAttribute('data-conn-id')
      if (connId && connIdSet.has(connId)) {
        p.classList.add('highlighted', 'locked')
        svg.appendChild(p)
      } else {
        p.classList.remove('highlighted', 'locked', 'pulse-anim')
      }
    })

    for (const c of conns) {
      highlightConnectedPorts(c.fromPortId, c.toPortId)
      highlightConnectedCards(c.fromSlug, c.toSlug)
    }

    showLockPill(title, subtitle)
  }

  function unlockActivePaths(resetHighlights = true): void {
    if (!lockedState && !overlayEl?.querySelector('#vs-graph-lock-pill')) return
    lockedState = null

    const pill = overlayEl?.querySelector('#vs-graph-lock-pill')
    pill?.remove()

    const svg = overlayEl?.querySelector('#vs-graph-svg') as SVGElement | null
    if (svg) {
      svg.querySelectorAll('.vs-graph-path.locked').forEach((p) => p.classList.remove('locked'))
    }

    if (resetHighlights) {
      if (hoveredConn) {
        highlightActivePath(hoveredConn)
      } else if (hoveredKeyInfo && hoveredKeyInfo.conns.length > 0) {
        highlightPortAndCurves(hoveredKeyInfo.portId, hoveredKeyInfo.type, hoveredKeyInfo.keyName, hoveredKeyInfo.stepTitle)
      } else {
        clearHighlights()
      }
    }
  }

  function renderConnections(): void {
    if (!currentGraphData || !overlayEl) return
    const svg = overlayEl.querySelector('#vs-graph-svg') as SVGElement | null
    const transformLayer = overlayEl.querySelector('#vs-graph-transform-layer') as HTMLElement | null
    if (!svg || !transformLayer) return

    svg.innerHTML = ''
    const layerRect = transformLayer.getBoundingClientRect()
    const allCards = Array.from(transformLayer.querySelectorAll<HTMLElement>('.vs-graph-card'))

    let maxAllCardBottom = 320
    for (const card of allCards) {
      const cTop = parseFloat(card.style.top) || 80
      const cBottom = cTop + (card.offsetHeight || 180)
      if (cBottom > maxAllCardBottom) {
        maxAllCardBottom = cBottom
      }
    }

    const calculatedConns: CalculatedConnection[] = []

    for (const conn of currentGraphData.connections) {
      let fromEl = (transformLayer.querySelector(`.port-out[data-port-id="${conn.fromPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-row[data-port-id="${conn.fromPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-nested-row[data-port-id="${conn.fromPortId}"]`)) as HTMLElement | null
      let toEl = (transformLayer.querySelector(`.port-in[data-port-id="${conn.toPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-row[data-port-id="${conn.toPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-nested-row[data-port-id="${conn.toPortId}"]`)) as HTMLElement | null

      if (!fromEl && conn.fromSlug) {
        fromEl = transformLayer.querySelector(`.vs-graph-card[data-node-id="${conn.fromSlug}"]`) as HTMLElement | null
      }
      if (!toEl && conn.toSlug) {
        toEl = transformLayer.querySelector(`.vs-graph-card[data-node-id="${conn.toSlug}"]`) as HTMLElement | null
      }

      if (!fromEl || !toEl) continue

      let fromTargetEl: HTMLElement = fromEl
      let toTargetEl: HTMLElement = toEl

      const fromCollapsed = fromEl.offsetParent === null
      const toCollapsed = toEl.offsetParent === null

      if (fromCollapsed) {
        const fromCard = fromEl.closest('.vs-graph-card')
        const outHeader = (fromCard?.querySelector('.output-section .vs-graph-section-header') || fromCard) as HTMLElement | null
        if (outHeader) fromTargetEl = outHeader
      }

      if (toCollapsed) {
        const toCard = toEl.closest('.vs-graph-card')
        const inHeader = (toCard?.querySelector('.vs-graph-section:not(.output-section) .vs-graph-section-header') || toCard) as HTMLElement | null
        if (inHeader) toTargetEl = inHeader
      }

      const fromRect = fromTargetEl.getBoundingClientRect()
      const toRect = toTargetEl.getBoundingClientRect()

      const isFromDot = !fromCollapsed && fromTargetEl.classList.contains('vs-graph-port-dot')
      const isToDot = !toCollapsed && toTargetEl.classList.contains('vs-graph-port-dot')
      const isFromCard = fromTargetEl.classList.contains('vs-graph-card')
      const isToCard = toTargetEl.classList.contains('vs-graph-card')

      const fromX = isFromDot ? fromRect.left + fromRect.width / 2 - layerRect.left : fromRect.right - layerRect.left
      const toX = isToDot ? toRect.left + toRect.width / 2 - layerRect.left : toRect.left - layerRect.left

      const x1 = fromX / zoom
      const y1 = (isFromCard ? fromRect.top + 28 - layerRect.top : fromRect.top + fromRect.height / 2 - layerRect.top) / zoom
      const x2 = toX / zoom
      const y2 = (isToCard ? toRect.top + 28 - layerRect.top : toRect.top + toRect.height / 2 - layerRect.top) / zoom

      const isSequentialConn = conn.expression === 'sequential'
      const isReverse = x2 < x1 - 20

      // Check if any intermediate cards lie between x1 and x2
      const minX = Math.min(x1, x2)
      const maxX = Math.max(x1, x2)
      let hasIntermediateCard = false

      for (const card of allCards) {
        const cLeft = parseFloat(card.style.left) || 0
        const cRight = cLeft + (card.offsetWidth || 360)
        if (cRight > minX + 30 && cLeft < maxX - 30) {
          hasIntermediateCard = true
          break
        }
      }

      const isMultiSpan = hasIntermediateCard || Math.abs(x2 - x1) > 220 || isReverse

      calculatedConns.push({
        conn,
        x1,
        y1,
        x2,
        y2,
        isSequentialConn,
        isMultiSpan,
        isReverse,
      })
    }

    // Allocate lanes for multi-span connections to eliminate any overlapping
    const multiSpanConns = calculatedConns.filter((c) => c.isMultiSpan)
    multiSpanConns.sort((a, b) => (a.x1 - b.x1) || (a.x2 - b.x2) || (a.y2 - b.y2))

    const laneOccupiedUntil: number[] = []
    for (const item of multiSpanConns) {
      let assigned = -1
      for (let l = 0; l < laneOccupiedUntil.length; l++) {
        const occ = laneOccupiedUntil[l]
        if (occ !== undefined && occ < item.x1 - 30) {
          assigned = l
          laneOccupiedUntil[l] = Math.max(item.x1, item.x2) + 30
          break
        }
      }
      if (assigned === -1) {
        assigned = laneOccupiedUntil.length
        laneOccupiedUntil.push(Math.max(item.x1, item.x2) + 30)
      }
      item.laneIndex = assigned
    }

    const baseLaneY = Math.max(340, maxAllCardBottom + 30)

    for (const item of calculatedConns) {
      let pathD: string
      if (item.isMultiSpan && item.laneIndex !== undefined) {
        const laneY = baseLaneY + item.laneIndex * 22
        if (!item.isReverse) {
          const spanDist = item.x2 - item.x1
          const cornerX = Math.min(80, Math.max(48, spanDist * 0.08))
          const c1 = cornerX * 0.55
          const c2 = cornerX * 0.45
          pathD = `M ${item.x1} ${item.y1} C ${item.x1 + c1} ${item.y1}, ${item.x1 + cornerX - c2} ${laneY}, ${item.x1 + cornerX} ${laneY} L ${item.x2 - cornerX} ${laneY} C ${item.x2 - cornerX + c2} ${laneY}, ${item.x2 - c1} ${item.y2}, ${item.x2} ${item.y2}`
        } else {
          const corner = 60
          pathD = `M ${item.x1} ${item.y1} C ${item.x1 + corner} ${item.y1}, ${item.x1 + corner} ${laneY}, ${item.x1} ${laneY} L ${item.x2} ${laneY} C ${item.x2 - corner} ${laneY}, ${item.x2 - corner} ${item.y2}, ${item.x2} ${item.y2}`
        }
      } else {
        const dx = Math.max(45, (item.x2 - item.x1) * 0.45)
        pathD = `M ${item.x1} ${item.y1} C ${item.x1 + dx} ${item.y1}, ${item.x2 - dx} ${item.y2}, ${item.x2} ${item.y2}`
      }

      const isLocked = lockedState?.conns.some((c) => c.id === item.conn.id) ?? false

      // Invisible fat hit-area path for smooth, reliable hover tracking
      const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      hitPath.setAttribute('d', pathD)
      hitPath.setAttribute('class', 'vs-graph-path-hitarea')
      hitPath.setAttribute('data-conn-id', item.conn.id)
      hitPath.setAttribute('data-from-port', item.conn.fromPortId)
      hitPath.setAttribute('data-to-port', item.conn.toPortId)

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', pathD)
      path.setAttribute(
        'class',
        item.isSequentialConn
          ? isLocked
            ? 'vs-graph-path sequential highlighted locked'
            : 'vs-graph-path sequential'
          : isLocked
            ? 'vs-graph-path highlighted locked'
            : 'vs-graph-path'
      )
      path.setAttribute('data-conn-id', item.conn.id)
      path.setAttribute('data-from-port', item.conn.fromPortId)
      path.setAttribute('data-to-port', item.conn.toPortId)

      const onWireEnter = (e: MouseEvent) => {
        hoveredConn = item.conn
        hoveredKeyInfo = null
        const tip = item.isSequentialConn
          ? `Sequential Order: ${item.conn.fromSlug} ➔ ${item.conn.toSlug}`
          : `${item.conn.fromSlug}.${item.conn.fromField} ➔ ${item.conn.toSlug}.${item.conn.toField}`
        const isThisLocked = lockedState?.conns.some((c) => c.id === item.conn.id)
        const shortcut = isThisLocked ? 'Space: Unlock' : 'Space: Lock path • Click for details'
        const detail = item.isSequentialConn
          ? 'Sequential execution flow'
          : (item.conn.expression ? `${item.conn.expression} = ${item.conn.valuePreview}` : `Value: ${item.conn.valuePreview}`)
        showTooltip(e.clientX, e.clientY, tip, shortcut, detail)

        if (lockedState) return
        highlightActivePath(item.conn)
      }

      const onWireMove = (e: MouseEvent) => {
        const tip = item.isSequentialConn
          ? `Sequential Order: ${item.conn.fromSlug} ➔ ${item.conn.toSlug}`
          : `${item.conn.fromSlug}.${item.conn.fromField} ➔ ${item.conn.toSlug}.${item.conn.toField}`
        const isThisLocked = lockedState?.conns.some((c) => c.id === item.conn.id)
        const shortcut = isThisLocked ? 'Space: Unlock' : 'Space: Lock path • Click for details'
        const detail = item.isSequentialConn
          ? 'Sequential execution flow'
          : (item.conn.expression ? `${item.conn.expression} = ${item.conn.valuePreview}` : `Value: ${item.conn.valuePreview}`)
        showTooltip(e.clientX, e.clientY, tip, shortcut, detail)
      }

      const onWireLeave = () => {
        hoveredConn = null
        hideTooltip()
        if (lockedState) return
        clearHighlights()
      }

      const onWireClick = () => {
        showDetailsModal(`Connection: ${item.conn.fromSlug}.${item.conn.fromField} ➔ ${item.conn.toSlug}.${item.conn.toField}`, {
          fromStep: item.conn.fromSlug,
          fromField: item.conn.fromField,
          toStep: item.conn.toSlug,
          toField: item.conn.toField,
          expression: item.conn.expression,
          runtimeValue: item.conn.valuePreview,
        })
      }

      hitPath.addEventListener('mouseenter', onWireEnter)
      hitPath.addEventListener('mousemove', onWireMove)
      hitPath.addEventListener('mouseleave', onWireLeave)
      hitPath.addEventListener('click', onWireClick)

      path.addEventListener('mouseenter', onWireEnter)
      path.addEventListener('mousemove', onWireMove)
      path.addEventListener('mouseleave', onWireLeave)
      path.addEventListener('click', onWireClick)

      svg.appendChild(hitPath)
      svg.appendChild(path)
    }

    if (lockedState) {
      svg.classList.add('has-active-connection')
      for (const c of lockedState.conns) {
        highlightConnectedPorts(c.fromPortId, c.toPortId)
        highlightConnectedCards(c.fromSlug, c.toSlug)
      }
      showLockPill(lockedState.title, lockedState.subtitle)
    }
  }

  function highlightPortAndCurves(portId: string, type: 'input' | 'output', keyName?: string, stepTitle?: string): void {
    if (!overlayEl) return
    const svg = overlayEl.querySelector('#vs-graph-svg') as SVGElement | null
    if (!svg) return

    const matchingConns = currentGraphData?.connections.filter((c) =>
      type === 'output' ? c.fromPortId === portId : c.toPortId === portId
    ) || []

    if (keyName && stepTitle && matchingConns.length > 0) {
      hoveredKeyInfo = {
        portId,
        type,
        keyName,
        stepTitle,
        conns: matchingConns,
      }
      hoveredConn = null
    }

    svg.classList.add('has-active-connection')
    const paths = Array.from(overlayEl.querySelectorAll<SVGPathElement>('.vs-graph-path'))

    for (const p of paths) {
      const fromPort = p.getAttribute('data-from-port')
      const toPort = p.getAttribute('data-to-port')

      if ((type === 'output' && fromPort === portId) || (type === 'input' && toPort === portId)) {
        p.classList.add('highlighted', 'pulse-anim')
        if (fromPort) {
          const fromRow = overlayEl.querySelector(`.vs-graph-row[data-port-id="${fromPort}"], .vs-graph-nested-row[data-port-id="${fromPort}"]`)
          fromRow?.classList.add('highlighted-source')
          fromRow?.querySelector('.port-out')?.classList.add('highlighted')
        }
        if (toPort) {
          const toRow = overlayEl.querySelector(`.vs-graph-row[data-port-id="${toPort}"], .vs-graph-nested-row[data-port-id="${toPort}"]`)
          toRow?.classList.add('highlighted')
          toRow?.querySelector('.port-in')?.classList.add('highlighted')
        }
      }
    }

    for (const c of matchingConns) {
      highlightConnectedCards(c.fromSlug, c.toSlug)
    }
  }

  function highlightConnectedPorts(fromPortId: string, toPortId: string): void {
    if (!overlayEl) return
    const fromRow = overlayEl.querySelector(`.vs-graph-row[data-port-id="${fromPortId}"], .vs-graph-nested-row[data-port-id="${fromPortId}"]`)
    fromRow?.classList.add('highlighted-source')
    fromRow?.querySelector('.port-out')?.classList.add('highlighted')

    const toRow = overlayEl.querySelector(`.vs-graph-row[data-port-id="${toPortId}"], .vs-graph-nested-row[data-port-id="${toPortId}"]`)
    toRow?.classList.add('highlighted')
    toRow?.querySelector('.port-in')?.classList.add('highlighted')
  }

  function clearHighlights(): void {
    if (!overlayEl || lockedState) return
    const svg = overlayEl.querySelector('#vs-graph-svg')
    svg?.classList.remove('has-active-connection')
    overlayEl.querySelectorAll('.vs-graph-path').forEach((p) => p.classList.remove('highlighted', 'pulse-anim', 'locked'))
    overlayEl.querySelectorAll('.vs-graph-row, .vs-graph-nested-row').forEach((r) => r.classList.remove('highlighted', 'highlighted-source'))
    overlayEl.querySelectorAll('.vs-graph-port-dot').forEach((d) => d.classList.remove('highlighted'))
    overlayEl.querySelectorAll('.vs-graph-card').forEach((c) => c.classList.remove('card-connected-highlight', 'card-source-highlight', 'card-target-highlight'))
  }

  const onDocClick = (e: MouseEvent): void => {
    if (!isGraphActive) return
    const target = e.target as HTMLElement | null

    const zoomInBtn = target?.closest('[data-testid="zoom-in-button"]')
    if (zoomInBtn) {
      e.preventDefault()
      e.stopPropagation()
      setZoom(zoom * 1.15)
      return
    }

    const zoomOutBtn = target?.closest('[data-testid="zoom-out-button"]')
    if (zoomOutBtn) {
      e.preventDefault()
      e.stopPropagation()
      setZoom(zoom / 1.15)
      return
    }

    const zoomFitBtn = target?.closest('[data-testid="zoom-fit-button"]')
    if (zoomFitBtn) {
      e.preventDefault()
      e.stopPropagation()
      fitView(true)
      return
    }

    if (
      target?.closest('[data-testid="logs-data-time-chip"]') ||
      target?.closest('[data-testid="workflow-navbar-logs-time-chip-container"]') ||
      target?.closest('.vs-graph-run-chip')
    ) {
      setTimeout(() => {
        if (isGraphActive) fitView(true)
      }, 150)
      setTimeout(() => {
        if (isGraphActive) fitView(true)
      }, 350)
    }

    const actionBtn = target?.closest('button')
    if (actionBtn) {
      const text = actionBtn.textContent?.trim().toLowerCase() || ''
      if (text === 'save' || text === 'update' || text.includes('save &') || text === 'dry run') {
        setTimeout(() => {
          if (isGraphActive) void refresh()
        }, 300)
        setTimeout(() => {
          if (isGraphActive) void refresh()
        }, 700)
        setTimeout(() => {
          if (isGraphActive) void refresh()
        }, 1400)
      }
    }
  }
  document.addEventListener('click', onDocClick, true)

  function updateFilterCounts(): void {
    if (!overlayEl || !currentGraphData) return
    const { summary } = currentGraphData
    const allBtn = overlayEl.querySelector('.vs-graph-filter-btn[data-filter="all"]')
    if (allBtn) allBtn.textContent = `All (${summary.totalSteps})`
    const depBtn = overlayEl.querySelector('.vs-graph-filter-btn[data-filter="dependent"]')
    if (depBtn) depBtn.textContent = `Dependent (${summary.dependentSteps})`
    const indBtn = overlayEl.querySelector('.vs-graph-filter-btn[data-filter="independent"]') as HTMLElement | null
    if (indBtn) {
      indBtn.textContent = `Independent (${summary.independentSteps})`
      indBtn.style.display = summary.independentSteps > 0 ? '' : 'none'
    }
  }

  let isRefreshing = false
  async function refresh(): Promise<void> {
    if (!isGraphActive || isRefreshing) return
    isRefreshing = true
    try {
      const data = await bridge.getFlowGraphData()
      if (data && isGraphActive) {
        currentGraphData = data
        updateFilterCounts()
        layoutAndRenderNodes()
      }
    } finally {
      isRefreshing = false
    }
  }

  const onStepPasted = (): void => {
    if (isGraphActive) {
      void refresh()
      setTimeout(() => {
        if (isGraphActive) void refresh()
      }, 350)
      setTimeout(() => {
        if (isGraphActive) void refresh()
      }, 800)
    }
  }
  const onStepDeleted = (): void => {
    if (isGraphActive) {
      void refresh()
      setTimeout(() => {
        if (isGraphActive) void refresh()
      }, 350)
    }
  }
  window.addEventListener('vs-step-pasted', onStepPasted)
  window.addEventListener('vs-step-deleted', onStepDeleted)

  const unsubscribeFlowChanged = bridge.onFlowGraphChanged(() => {
    if (isGraphActive) {
      void refresh()
    }
  })

  const interval = setInterval(() => {
    ensureTabButton()

    if (isGraphActive) {
      ensureLogsDrawerZIndex()
      const drawer = getLogsHistoryDrawer()
      const isDrawerOpen = !!drawer
      if (isDrawerOpen !== lastDrawerOpen) {
        lastDrawerOpen = isDrawerOpen
        fitView(true)
      }

      const currentFlowHitId = new URLSearchParams(window.location.search).get('flowhitid') || ''
      if (currentFlowHitId !== lastFlowHitId) {
        lastFlowHitId = currentFlowHitId
        bridge.getFlowGraphData().then((data) => {
          if (data && isGraphActive) {
            currentGraphData = data
            renderView()
            requestAnimationFrame(() => fitView(true))
          }
        })
      }

      const currentTimestamp = new URLSearchParams(window.location.search).get('timestamp') || ''
      if (currentTimestamp !== lastTimestamp) {
        lastTimestamp = currentTimestamp
        void refresh()
      }
    }
  }, 350)

  const onPopState = (): void => {
    hideTabTooltip()
    if (isGraphActive) {
      if (window.location.pathname.includes('/workflow/') && window.location.pathname.endsWith('/draft')) {
        const currentFlowHitId = new URLSearchParams(window.location.search).get('flowhitid') || ''
        if (currentFlowHitId !== lastFlowHitId) {
          lastFlowHitId = currentFlowHitId
          bridge.getFlowGraphData().then((data) => {
            if (data && isGraphActive) {
              currentGraphData = data
              renderView()
              requestAnimationFrame(() => fitView(true))
            }
          })
        }
        const currentTimestamp = new URLSearchParams(window.location.search).get('timestamp') || ''
        if (currentTimestamp !== lastTimestamp) {
          lastTimestamp = currentTimestamp
          void refresh()
        }
      } else {
        close()
      }
    }
    ensureTabButton()
  }
  window.addEventListener('popstate', onPopState)

  const onResize = (): void => {
    if (isGraphActive) {
      renderConnections()
    }
  }
  window.addEventListener('resize', onResize)

  const onWindowClick = (): void => {
    if (isGraphActive) {
      setTimeout(ensureLogsDrawerZIndex, 50)
    }
  }
  window.addEventListener('click', onWindowClick, { passive: true })

  const onGraphKeyDown = (e: KeyboardEvent): void => {
    if (!isGraphActive) return

    const activeEl = document.activeElement as HTMLElement | null
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable ||
        activeEl.closest('.MuiInputBase-root'))
    ) {
      return
    }

    if (e.code === 'Space') {
      e.preventDefault()
      e.stopPropagation()

      if (lockedState) {
        unlockActivePaths(true)
      } else if (hoveredKeyInfo && hoveredKeyInfo.conns.length > 0) {
        const count = hoveredKeyInfo.conns.length
        const title = `Key Locked: ${hoveredKeyInfo.stepTitle}.${hoveredKeyInfo.keyName}`
        const subtitle = count === 1 ? '(1 path locked)' : `(${count} paths locked)`
        lockActivePaths(hoveredKeyInfo.conns, title, subtitle, true)
        hideTooltip()
      } else if (hoveredConn) {
        const title = `${hoveredConn.fromSlug}.${hoveredConn.fromField} ➔ ${hoveredConn.toSlug}.${hoveredConn.toField}`
        const subtitle = hoveredConn.valuePreview ? `(${hoveredConn.valuePreview})` : ''
        lockActivePaths([hoveredConn], title, subtitle, false)
        hideTooltip()
      }
      return
    }

    if (e.code === 'Escape' && lockedState) {
      e.preventDefault()
      unlockActivePaths(true)
    }
  }
  window.addEventListener('keydown', onGraphKeyDown, true)

  return {
    open,
    close,
    refresh,
    destroy() {
      themeObserver.disconnect()
      clearInterval(interval)
      document.removeEventListener('click', onDocClick, true)
      window.removeEventListener('click', onWindowClick)
      window.removeEventListener('keydown', onGraphKeyDown, true)
      document.body.classList.remove('vs-graph-active')
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('vs-step-pasted', onStepPasted)
      window.removeEventListener('vs-step-deleted', onStepDeleted)
      unsubscribeFlowChanged()
      hideTabTooltip()
      close()
      overlayEl?.remove()
      overlayEl = null
      tooltipEl?.remove()
      tooltipEl = null
      document.getElementById(STYLE_ID)?.remove()
      document.querySelector(`[data-testid="${TAB_BUTTON_TESTID}"]`)?.parentElement?.remove()
    },
  }
}
