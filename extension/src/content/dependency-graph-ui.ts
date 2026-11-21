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

#${OVERLAY_ID} {
  position: absolute;
  inset: 0;
  z-index: 8;
  background-color: #0d1117;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  color: rgb(240, 246, 252);
}

/* viaSocket dot grid canvas background */
.vs-graph-canvas-bg {
  position: absolute;
  inset: 0;
  background-color: #0d1117;
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.08) 1.2px, transparent 1.2px);
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
  border: 1px solid var(--col-border, rgba(213, 217, 220, 0.24));
  background: rgba(21, 27, 35, 0.92);
  backdrop-filter: blur(8px);
  font-size: 12px;
  color: #8b949e;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
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
  border: 1px solid var(--col-border, rgba(213, 217, 220, 0.24));
  background: rgba(21, 27, 35, 0.92);
  backdrop-filter: blur(8px);
  padding: 2px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  user-select: none;
}

.vs-graph-filter-btn {
  background: transparent;
  border: none;
  color: #8b949e;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}

.vs-graph-filter-btn:hover {
  color: #f0f6fc;
}

.vs-graph-filter-btn.active {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  font-weight: 600;
}

/* Back button */
.vs-graph-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--col-border, rgba(213, 217, 220, 0.24));
  background: rgba(21, 27, 35, 0.92);
  backdrop-filter: blur(8px);
  font-size: 12px;
  font-weight: 500;
  color: #c9d1d9;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  font-family: inherit;
  user-select: none;
}

.vs-graph-back-btn:hover {
  background: #21262d;
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.25);
}

/* Floating bottom zoom controls */
.vs-graph-bottom-controls {
  display: none !important;
}

/* Hide flow canvas help card when in graph view so it does not overlap Back to Flow */
body.vs-graph-active [data-testid="build-flow-card"] {
  display: none !important;
}

.vs-graph-zoom-group {
  display: flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--col-border, rgba(213, 217, 220, 0.24));
  background: rgba(21, 27, 35, 0.92);
  backdrop-filter: blur(8px);
  padding: 3px 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.vs-graph-zoom-btn {
  background: transparent;
  border: none;
  color: #8b949e;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.vs-graph-zoom-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.08);
}

.vs-graph-zoom-level {
  font-size: 12px;
  font-family: Inter, system-ui, sans-serif;
  color: #8b949e;
  padding: 0 8px;
  min-width: 44px;
  text-align: center;
}

.vs-graph-zoom-divider {
  width: 1px;
  height: 14px;
  background: rgba(255, 255, 255, 0.12);
  margin: 0 4px;
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

.vs-graph-path {
  fill: none;
  stroke: #58a6ff;
  stroke-width: 2px;
  stroke-linecap: round;
  pointer-events: stroke;
  cursor: pointer;
  transition: stroke 0.15s ease, stroke-width 0.15s ease, opacity 0.15s ease;
  opacity: 0.8;
}

.vs-graph-path:hover,
.vs-graph-path.highlighted {
  stroke: #79c0ff !important;
  stroke-width: 3.2px !important;
  opacity: 1 !important;
  filter: drop-shadow(0 0 5px rgba(88, 166, 255, 0.75));
}

.vs-graph-path.pulse-anim {
  stroke-dasharray: 6, 4;
  animation: vs-flow-dash 1.2s linear infinite;
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
  background-color: rgb(21, 27, 35);
  border: 1.5px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  color: rgb(240, 246, 252);
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  user-select: none;
  overflow: visible;
}

.vs-graph-card:hover {
  border-color: rgba(255, 255, 255, 0.24);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
  z-index: 7;
}

.vs-graph-card.selected {
  border-color: #58a6ff;
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.25);
  z-index: 8;
}

/* Header */
.vs-graph-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
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
  background: #161b22;
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

.vs-graph-card-title {
  font-size: 13px;
  font-weight: 600;
  color: rgb(240, 246, 252);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vs-graph-card-url {
  font-size: 11px;
  color: #8b949e;
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
  background: rgba(255, 255, 255, 0.08);
  color: #8b949e;
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
  color: #8b949e;
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
  color: #f0f6fc;
  background-color: rgba(255, 255, 255, 0.08);
}

/* JSON Crack-style Structured Node Table */
.vs-graph-section {
  width: 100%;
}

.vs-graph-section.output-section {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.vs-graph-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  background: rgba(0, 0, 0, 0.22);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.12s ease;
}

.vs-graph-section-header:hover {
  background: rgba(255, 255, 255, 0.06);
}

.vs-graph-section-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vs-graph-section-chevron {
  font-size: 10px;
  color: #8b949e;
  line-height: 1;
  display: inline-block;
  transition: transform 0.15s ease, color 0.15s ease;
}

.vs-graph-section-header:hover .vs-graph-section-chevron {
  color: #f0f6fc;
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
  color: #8b949e;
  text-transform: uppercase;
  font-family: Inter, system-ui, sans-serif;
  transition: color 0.12s ease;
}

.vs-graph-section-header:hover .vs-graph-section-tag {
  color: #c9d1d9;
}

.vs-graph-section-count {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: #8b949e;
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
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
  user-select: text;
}

.vs-graph-row:last-child {
  border-bottom: none;
}

.vs-graph-row:hover,
.vs-graph-row.highlighted {
  background-color: rgba(88, 166, 255, 0.12);
}

.vs-graph-row.highlighted-source {
  background-color: rgba(88, 166, 255, 0.18);
}

/* Expand / Collapse Button matching JSON Crack */
.vs-graph-expand-btn {
  width: 14px;
  height: 14px;
  min-width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 3px;
  color: #8b949e;
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
  background: rgba(88, 166, 255, 0.2);
  border-color: rgba(88, 166, 255, 0.4);
  color: #ffffff;
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
  border-left: 1.5px solid rgba(110, 118, 129, 0.25);
  background: rgba(0, 0, 0, 0.15);
  border-radius: 0 0 4px 4px;
  transition: border-color 0.15s ease;
}

.vs-graph-nested-container:hover {
  border-left-color: rgba(88, 166, 255, 0.5);
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
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  cursor: pointer;
  transition: background-color 0.12s ease;
  user-select: text;
}

.vs-graph-nested-row:last-child {
  border-bottom: none;
}

.vs-graph-nested-row:hover,
.vs-graph-nested-row.highlighted {
  background-color: rgba(88, 166, 255, 0.1);
}

.vs-graph-nested-row.highlighted-source {
  background-color: rgba(88, 166, 255, 0.16);
}

.vs-graph-row-key {
  color: #79c0ff;
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
  color: #a5d6ff;
  font-weight: 500;
  opacity: 0.9;
}

.vs-graph-row-colon {
  color: #6e7681;
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
  color: #8b949e;
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
  color: #58a6ff;
}

.vs-graph-show-more-row {
  padding: 4px 10px;
  font-size: 10px;
  color: #58a6ff;
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
  color: #79c0ff;
  background-color: rgba(88, 166, 255, 0.08);
}

/* Syntax highlighted value types (inspired by JSON Crack & GitHub dark) */
.vs-val-str {
  color: #7ee787;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vs-val-num {
  color: #ffa657;
  font-weight: 500;
}

.vs-val-bool {
  color: #58a6ff;
  font-weight: 600;
}

.vs-val-null {
  color: #8b949e;
  font-style: italic;
}

.vs-val-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
  border: 1px solid rgba(255, 255, 255, 0.2);
  flex-shrink: 0;
}

.vs-val-badge {
  display: inline-block;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  background: rgba(110, 118, 129, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #c9d1d9;
}

.vs-val-badge.expandable {
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.vs-val-badge.expandable:hover {
  background-color: rgba(88, 166, 255, 0.2);
  border-color: rgba(88, 166, 255, 0.4);
}

.vs-val-array {
  color: #d2a8ff;
  border-color: rgba(210, 168, 255, 0.25);
  background: rgba(210, 168, 255, 0.08);
}

.vs-val-obj {
  color: #a5d6ff;
  border-color: rgba(165, 214, 255, 0.25);
  background: rgba(165, 214, 255, 0.08);
}

/* Minimal port connection dots anchored directly on row */
.vs-graph-port-dot {
  position: absolute;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #151b23;
  border: 1.5px solid #58a6ff;
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
  background-color: #58a6ff;
  box-shadow: 0 0 8px #58a6ff;
  transform: translateY(-50%) scale(1.35);
}

/* Independent lane */
.vs-graph-independent-lane {
  position: absolute;
  border: 1px dashed rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.015);
  border-radius: 10px;
  padding: 16px 20px;
  z-index: 1;
  pointer-events: none;
}

.vs-graph-lane-header {
  position: absolute;
  top: -11px;
  left: 18px;
  background: #0d1117;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 500;
  color: #8b949e;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}

/* Tooltip floating bubble */
.vs-graph-tooltip {
  position: fixed;
  z-index: 2000;
  background: rgba(97, 97, 97, 0.94);
  color: #ffffff;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-family: inherit;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  display: none;
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
  background: #151b23;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.85);
  overflow: hidden;
  position: relative;
}

.vs-graph-modal-header {
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #161b22;
}

.vs-graph-modal-title {
  font-size: 13px;
  font-weight: 500;
  color: #f0f6fc;
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
  color: #c9d1d9;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
  line-height: 1.3;
}

.vs-graph-modal-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.28);
  color: #ffffff;
}

.vs-graph-modal-btn.copy {
  color: #58a6ff;
  border-color: rgba(88, 166, 255, 0.3);
  background: rgba(88, 166, 255, 0.08);
}

.vs-graph-modal-btn.copy:hover {
  background: rgba(88, 166, 255, 0.18);
  border-color: rgba(88, 166, 255, 0.5);
  color: #79c0ff;
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
  color: #c9d1d9;
  background: #0d1117;
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
  let savedNativeZoomText = ''

  let tooltipEl: HTMLElement | null = null
  let tabTooltipEl: HTMLElement | null = null
  let tabTooltipTimer: ReturnType<typeof setTimeout> | undefined

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

  function showTooltip(x: number, y: number, text: string): void {
    const el = getTooltip()
    el.innerText = text
    el.style.left = `${x + 12}px`
    el.style.top = `${y + 12}px`
    el.style.display = 'block'
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

    let graphBtn = tabsContainer.querySelector(`[data-testid="${TAB_BUTTON_TESTID}"]`) as HTMLButtonElement | null
    if (!graphBtn) {
      const span = document.createElement('span')
      span.className = 'vs-graph-tab-wrapper'
      span.setAttribute('aria-label', 'View dependency graph with inputs and outputs.')

      graphBtn = document.createElement('button')
      graphBtn.className =
        'MuiButtonBase-root MuiToggleButtonGroup-grouped MuiToggleButtonGroup-groupedHorizontal MuiToggleButton-root MuiToggleButton-sizeSmall MuiToggleButton-standard MuiToggleButtonGroup-grouped MuiToggleButtonGroup-groupedHorizontal MuiToggleButtonGroup-lastButton css-3zrywm'
      graphBtn.tabIndex = 0
      graphBtn.type = 'button'
      graphBtn.value = 'graph'
      graphBtn.setAttribute('aria-pressed', isGraphActive ? 'true' : 'false')
      if (isGraphActive) graphBtn.classList.add('Mui-selected')
      graphBtn.setAttribute('data-testid', TAB_BUTTON_TESTID)
      graphBtn.innerText = 'Graph'

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

      // Convert previous last button to middle button
      const logBtn = tabsContainer.querySelector('[data-testid="workflow-log-view-tab"]')
      if (logBtn) {
        logBtn.classList.remove('MuiToggleButtonGroup-lastButton')
        logBtn.classList.add('MuiToggleButtonGroup-middleButton')
      }

      tabsContainer.appendChild(span)

      graphBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        hideTabTooltip()
        open()
      })
    }

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
  }

  async function open(): Promise<void> {
    isGraphActive = true
    document.body.classList.add('vs-graph-active')
    updateTabButtonsState()

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
          Unable to load workflow graph data. Try selecting a test run or reload.
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
    document.body.classList.remove('vs-graph-active')
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

  function formatRunTimestamp(ts: string): string {
    try {
      const date = new Date(ts)
      if (isNaN(date.getTime())) return ts
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      if (diffMs < 0) return ts

      const diffSecs = Math.floor(diffMs / 1000)
      const diffMins = Math.floor(diffSecs / 60)
      const diffHours = Math.floor(diffMins / 60)
      const diffDays = Math.floor(diffHours / 24)

      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

      if (diffMins < 1) {
        return 'Just now'
      } else if (diffHours < 1) {
        return `${diffMins}m ago, ${timeStr}`
      } else if (diffHours < 24) {
        return `${diffHours}h ago, ${timeStr}`
      } else if (diffDays === 1) {
        return `yesterday, ${timeStr}`
      } else {
        return `${diffDays}d ago, ${timeStr}`
      }
    } catch {
      return ts
    }
  }

  function renderView(): void {
    if (!overlayEl || !currentGraphData) return

    const { summary, timestamp } = currentGraphData
    const displayTimestamp = timestamp ? formatRunTimestamp(timestamp) : ''
    const hasNativeChip = !!document.querySelector('[data-testid="workflow-navbar-logs-time-chip-container"]')

    overlayEl.innerHTML = `
      <div class="vs-graph-canvas-bg"></div>

      <!-- Top Floating Controls -->
      <div class="vs-graph-top-bar">
        <div class="vs-graph-top-left">
          ${hasNativeChip ? '' : `
            <div class="vs-graph-run-chip" id="vs-fallback-run-chip" title="Click to open or close logs history">
              <span class="vs-graph-run-dot"></span>
              <span>Showing data from ${displayTimestamp ? `run ${displayTimestamp}` : 'latest run'}</span>
            </div>
          `}
        </div>

        <div class="vs-graph-top-center">
          <div class="vs-graph-filter-group" role="group">
            <button class="vs-graph-filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
              All (${summary.totalSteps})
            </button>
            <button class="vs-graph-filter-btn ${currentFilter === 'dependent' ? 'active' : ''}" data-filter="dependent">
              Dependent (${summary.dependentSteps})
            </button>
            <button class="vs-graph-filter-btn ${currentFilter === 'independent' ? 'active' : ''}" data-filter="independent">
              Independent (${summary.independentSteps})
            </button>
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

      <!-- Floating Bottom Zoom Capsule (viaSocket standard) -->
      <div class="vs-graph-bottom-controls">
        <div class="vs-graph-zoom-group" role="group" data-testid="zoom-controls">
          <button class="vs-graph-zoom-btn" id="vs-zoom-out" title="Zoom Out" aria-label="Zoom Out">
            <svg class="MuiSvgIcon-root" viewBox="0 0 24 24" style="width:17px;height:17px;fill:currentColor;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14M7 9h5v1H7z"></path></svg>
          </button>
          <p class="vs-graph-zoom-level" id="vs-zoom-level">${Math.round(zoom * 100)}%</p>
          <button class="vs-graph-zoom-btn" id="vs-zoom-in" title="Zoom In" aria-label="Zoom In">
            <svg class="MuiSvgIcon-root" viewBox="0 0 24 24" style="width:17px;height:17px;fill:currentColor;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"></path><path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2z"></path></svg>
          </button>
          <div class="vs-graph-zoom-divider"></div>
          <button class="vs-graph-zoom-btn" id="vs-zoom-fit" title="Fit to Screen" aria-label="Fit to Screen">
            <svg class="MuiSvgIcon-root" viewBox="0 0 24 24" style="width:17px;height:17px;fill:currentColor;"><path d="M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3zM18 8H6v8h12z"></path></svg>
          </button>
          <div class="vs-graph-zoom-divider"></div>
          <button class="vs-graph-zoom-btn" id="vs-zoom-reset" title="Center View" aria-label="Center View">
            <svg class="MuiSvgIcon-root" viewBox="0 0 24 24" style="width:17px;height:17px;fill:currentColor;"><circle cx="12" cy="12" r="3"></circle><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"></path></svg>
          </button>
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
    overlayEl.querySelector('#vs-zoom-reset')?.addEventListener('click', () => {
      fitView(true)
    })
    overlayEl.querySelector('#vs-zoom-fit')?.addEventListener('click', () => {
      fitView(true)
    })
    overlayEl.querySelector('#vs-fallback-run-chip')?.addEventListener('click', () => {
      const nativeChip = document.querySelector('[data-testid="logs-data-time-chip"]') as HTMLElement | null
      nativeChip?.click()
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
    let isExpanded = false

    const formatted = formatJsonCrackValue(complex.isComplex ? complex.data : value)
    const tooltipText = expression ? `${expression} = ${formatted.text}` : `${currentPath} = ${formatted.text}`
    row.title = canExpand ? `${tooltipText} (Click to expand/collapse)` : `${tooltipText} (Click to inspect)`

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
      expandBtn.textContent = '+'
      expandBtn.setAttribute('aria-label', `Toggle ${key}`)
      expandBtn.title = 'Click to expand'
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
    inspectBtn.title = 'Inspect in modal'
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
      nestedContainer.style.display = 'none'
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

      const toggleExpand = () => {
        isExpanded = !isExpanded
        if (isExpanded) {
          if (expandBtn) {
            expandBtn.textContent = '−'
            expandBtn.title = 'Click to collapse'
          }
          nestedContainer!.style.display = 'flex'
          if (!renderedChildren) {
            populateChildren()
          }
        } else {
          if (expandBtn) {
            expandBtn.textContent = '+'
            expandBtn.title = 'Click to expand'
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

    // Hover highlights for port curves
    if (portId) {
      row.addEventListener('mouseenter', () => highlightPortAndCurves(portId, isInput ? 'input' : 'output'))
      row.addEventListener('mouseleave', clearHighlights)
    }

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
    const subtitle = isWebhook ? 'https://flow.sokt.io/func/scriwknFmRIS' : ''

    card.innerHTML = `
      <div class="vs-graph-card-header">
        <div class="vs-graph-card-avatar" title="Click to edit ${escapeHtml(node.title)}">
          <img alt="" src="${iconSrc}" />
        </div>
        <div class="vs-graph-card-title-box" title="Click to edit ${escapeHtml(node.title)}">
          <p class="vs-graph-card-title">${escapeHtml(node.title)}</p>
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

      const secHeader = document.createElement('div')
      secHeader.className = 'vs-graph-section-header'
      secHeader.setAttribute('role', 'button')
      secHeader.setAttribute('aria-expanded', 'true')
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

      const secHeader = document.createElement('div')
      secHeader.className = 'vs-graph-section-header'
      secHeader.setAttribute('role', 'button')
      secHeader.setAttribute('aria-expanded', 'true')
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

  function renderConnections(): void {
    if (!currentGraphData || !overlayEl) return
    const svg = overlayEl.querySelector('#vs-graph-svg') as SVGElement | null
    const transformLayer = overlayEl.querySelector('#vs-graph-transform-layer') as HTMLElement | null
    if (!svg || !transformLayer) return

    svg.innerHTML = ''
    const layerRect = transformLayer.getBoundingClientRect()

    for (const conn of currentGraphData.connections) {
      const fromEl = (transformLayer.querySelector(`.port-out[data-port-id="${conn.fromPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-row[data-port-id="${conn.fromPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-nested-row[data-port-id="${conn.fromPortId}"]`)) as HTMLElement | null
      const toEl = (transformLayer.querySelector(`.port-in[data-port-id="${conn.toPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-row[data-port-id="${conn.toPortId}"]`) ||
        transformLayer.querySelector(`.vs-graph-nested-row[data-port-id="${conn.toPortId}"]`)) as HTMLElement | null

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

      const fromX = isFromDot ? fromRect.left + fromRect.width / 2 - layerRect.left : fromRect.right - layerRect.left
      const toX = isToDot ? toRect.left + toRect.width / 2 - layerRect.left : toRect.left - layerRect.left

      const x1 = fromX / zoom
      const y1 = (fromRect.top + fromRect.height / 2 - layerRect.top) / zoom
      const x2 = toX / zoom
      const y2 = (toRect.top + toRect.height / 2 - layerRect.top) / zoom

      const dx = Math.max(50, Math.abs(x2 - x1) * 0.45)
      const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', pathD)
      path.setAttribute('class', 'vs-graph-path')
      path.setAttribute('data-conn-id', conn.id)
      path.setAttribute('data-from-port', conn.fromPortId)
      path.setAttribute('data-to-port', conn.toPortId)

      path.addEventListener('mouseenter', (e) => {
        path.classList.add('highlighted', 'pulse-anim')
        highlightConnectedPorts(conn.fromPortId, conn.toPortId)
        showTooltip(e.clientX, e.clientY, `${conn.fromSlug}.${conn.fromField} (${conn.valuePreview}) ➔ ${conn.toSlug}.${conn.toField}`)
      })

      path.addEventListener('mousemove', (e) => {
        showTooltip(e.clientX, e.clientY, `${conn.fromSlug}.${conn.fromField} (${conn.valuePreview}) ➔ ${conn.toSlug}.${conn.toField}`)
      })

      path.addEventListener('mouseleave', () => {
        path.classList.remove('highlighted', 'pulse-anim')
        clearHighlights()
        hideTooltip()
      })

      path.addEventListener('click', () => {
        showDetailsModal(`Connection: ${conn.fromSlug}.${conn.fromField} ➔ ${conn.toSlug}.${conn.toField}`, {
          fromStep: conn.fromSlug,
          fromField: conn.fromField,
          toStep: conn.toSlug,
          toField: conn.toField,
          expression: conn.expression,
          runtimeValue: conn.valuePreview,
        })
      })

      svg.appendChild(path)
    }
  }

  function highlightPortAndCurves(portId: string, type: 'input' | 'output'): void {
    if (!overlayEl) return
    const paths = Array.from(overlayEl.querySelectorAll('.vs-graph-path'))

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
    if (!overlayEl) return
    overlayEl.querySelectorAll('.vs-graph-path').forEach((p) => p.classList.remove('highlighted', 'pulse-anim'))
    overlayEl.querySelectorAll('.vs-graph-row, .vs-graph-nested-row').forEach((r) => r.classList.remove('highlighted', 'highlighted-source'))
    overlayEl.querySelectorAll('.vs-graph-port-dot').forEach((d) => d.classList.remove('highlighted'))
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
  }
  document.addEventListener('click', onDocClick, true)

  const interval = setInterval(() => {
    ensureTabButton()

    if (isGraphActive) {
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

  return {
    open,
    close,
    destroy() {
      clearInterval(interval)
      document.removeEventListener('click', onDocClick, true)
      document.body.classList.remove('vs-graph-active')
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('resize', onResize)
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
