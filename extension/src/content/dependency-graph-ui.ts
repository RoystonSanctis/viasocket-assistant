// Workflow Dependency Graph UI Controller
// Injects "Graph" tab into [data-testid="workflow-view-tabs"]
// Renders horizontal DAG canvas with data-flow connection strings and independent step separation

import type { FlowGraphConnection, FlowGraphData, FlowGraphNode, FlowGraphPort } from '../shared/messages'
import type { PageBridge } from './page-bridge'

const STYLE_ID = 'vs-dependency-graph-styles'
const TAB_BUTTON_TESTID = 'workflow-graph-view-tab'
const OVERLAY_ID = 'vs-dependency-graph-overlay'

const CSS = `
.vs-graph-tab-wrapper {
  display: inline-flex;
}

#${OVERLAY_ID} {
  position: absolute;
  inset: 0;
  z-index: 45;
  background-color: #0b0f17;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #f1f5f9;
}

/* Dot grid background */
.vs-graph-canvas-bg {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.08) 1.2px, transparent 1.2px);
  background-size: 24px 24px;
  pointer-events: none;
}

/* Toolbar */
.vs-graph-toolbar {
  height: 52px;
  min-height: 52px;
  background: rgba(15, 23, 42, 0.9);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  z-index: 10;
  user-select: none;
}

.vs-graph-title-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.vs-graph-title {
  font-size: 14px;
  font-weight: 600;
  color: #f8fafc;
  display: flex;
  align-items: center;
  gap: 6px;
}

.vs-graph-pill {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.vs-graph-pill-run {
  background: rgba(16, 185, 129, 0.1);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.vs-graph-pill-count {
  background: rgba(255, 255, 255, 0.06);
  color: #94a3b8;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.vs-graph-pill-dep {
  background: rgba(99, 102, 241, 0.12);
  color: #818cf8;
  border: 1px solid rgba(99, 102, 241, 0.25);
}

.vs-graph-pill-indep {
  background: rgba(20, 184, 166, 0.12);
  color: #2dd4bf;
  border: 1px solid rgba(20, 184, 166, 0.25);
}

/* Filter controls */
.vs-graph-filters {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}

.vs-graph-filter-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.vs-graph-filter-btn:hover {
  color: #f1f5f9;
  background: rgba(255, 255, 255, 0.04);
}

.vs-graph-filter-btn.active {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
  font-weight: 600;
}

/* Actions right */
.vs-graph-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vs-graph-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #cbd5e1;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.vs-graph-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #f8fafc;
}

.vs-graph-close-btn {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: #f87171;
}

.vs-graph-close-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

/* Canvas viewport */
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
  stroke: #475569;
  stroke-width: 2.2px;
  stroke-linecap: round;
  pointer-events: stroke;
  cursor: pointer;
  transition: stroke 0.2s ease, stroke-width 0.2s ease, opacity 0.2s ease;
  opacity: 0.75;
}

.vs-graph-path:hover,
.vs-graph-path.highlighted {
  stroke: #38bdf8 !important;
  stroke-width: 3.8px !important;
  opacity: 1 !important;
  filter: drop-shadow(0 0 6px rgba(56, 189, 248, 0.8));
}

.vs-graph-path.pulse-anim {
  stroke-dasharray: 6, 4;
  animation: vs-dash-flow 1.2s linear infinite;
}

@keyframes vs-dash-flow {
  from { stroke-dashoffset: 20; }
  to { stroke-dashoffset: 0; }
}

/* Nodes */
.vs-graph-nodes-layer {
  position: relative;
  z-index: 3;
}

.vs-graph-card {
  position: absolute;
  width: 330px;
  background: #141b24;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.6);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.vs-graph-card:hover {
  border-color: rgba(255, 255, 255, 0.22);
  box-shadow: 0 14px 40px -5px rgba(0, 0, 0, 0.8);
}

.vs-graph-card.is-independent {
  border-left: 3px solid #14b8a6;
}

.vs-graph-card.is-trigger {
  border-left: 3px solid #38bdf8;
}

.vs-graph-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.vs-graph-card-title-box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.vs-graph-card-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.vs-graph-card-icon.icon-webhook {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.vs-graph-card-icon.icon-js {
  background: #f7df1e;
  color: #000000;
}

.vs-graph-card-icon.icon-plugin {
  background: #1e293b;
  overflow: hidden;
}

.vs-graph-card-name {
  font-size: 13px;
  font-weight: 600;
  color: #f1f5f9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vs-graph-card-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.vs-graph-type-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
  text-transform: uppercase;
  font-weight: 600;
}

.vs-graph-dep-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.vs-graph-dep-badge.dep-independent {
  background: rgba(20, 184, 166, 0.18);
  color: #2dd4bf;
  border: 1px solid rgba(20, 184, 166, 0.3);
}

.vs-graph-dep-badge.dep-chain {
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
  border: 1px solid rgba(99, 102, 241, 0.3);
}

/* Ports list */
.vs-graph-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.vs-graph-section-header {
  font-size: 10px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.vs-graph-ports-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.vs-graph-port-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  transition: all 0.15s ease;
}

.vs-graph-port-row:hover,
.vs-graph-port-row.highlighted {
  background: rgba(56, 189, 248, 0.1);
  border-color: rgba(56, 189, 248, 0.4);
}

.vs-graph-port-row.highlighted-source {
  background: rgba(129, 140, 248, 0.15);
  border-color: rgba(129, 140, 248, 0.5);
}

.vs-graph-port-dot {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #0f172a;
  border: 2px solid #64748b;
  transition: all 0.2s ease;
  z-index: 5;
}

.vs-graph-port-dot.port-in {
  left: -6px;
}

.vs-graph-port-dot.port-out {
  right: -6px;
}

.vs-graph-port-dot:hover,
.vs-graph-port-dot.highlighted {
  border-color: #38bdf8;
  background: #38bdf8;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.9);
  transform: scale(1.25);
}

.vs-graph-port-key {
  color: #cbd5e1;
  font-weight: 500;
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vs-graph-port-dash {
  color: #64748b;
  font-weight: 400;
}

.vs-graph-port-val {
  color: #38bdf8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10.5px;
  margin-left: auto;
  max-width: 130px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 5px;
  border-radius: 4px;
}

/* Independent Section Lane */
.vs-graph-independent-lane {
  position: absolute;
  border: 1px dashed rgba(20, 184, 166, 0.35);
  background: rgba(20, 184, 166, 0.03);
  border-radius: 16px;
  padding: 20px;
  z-index: 1;
}

.vs-graph-lane-label {
  position: absolute;
  top: -12px;
  left: 20px;
  background: #0b0f17;
  border: 1px solid rgba(20, 184, 166, 0.4);
  color: #2dd4bf;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Floating Tooltip */
.vs-graph-tooltip {
  position: fixed;
  z-index: 100;
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #f8fafc;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  display: none;
}

/* JSON Details Modal */
.vs-graph-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vs-graph-modal {
  width: 580px;
  max-width: 90vw;
  max-height: 80vh;
  background: #131b26;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
  overflow: hidden;
}

.vs-graph-modal-header {
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.vs-graph-modal-title {
  font-size: 14px;
  font-weight: 600;
  color: #f8fafc;
}

.vs-graph-modal-body {
  padding: 16px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #cbd5e1;
  background: #0d1219;
}
`

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
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

  let pan = { x: 80, y: 60 }
  let zoom = 1.0
  let isDragging = false
  let dragStart = { x: 0, y: 0 }
  let panStart = { x: 0, y: 0 }

  let tooltipEl: HTMLElement | null = null

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
    el.style.left = `${x + 14}px`
    el.style.top = `${y + 14}px`
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

    const closeBtn = document.createElement('button')
    closeBtn.className = 'vs-graph-btn'
    closeBtn.innerText = '✕ Close'
    closeBtn.onclick = () => backdrop.remove()

    header.appendChild(titleEl)
    header.appendChild(closeBtn)

    const body = document.createElement('pre')
    body.className = 'vs-graph-modal-body'
    try {
      body.innerText = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    } catch {
      body.innerText = String(data)
    }

    modal.appendChild(header)
    modal.appendChild(body)
    backdrop.appendChild(modal)

    backdrop.onclick = (e) => {
      if (e.target === backdrop) backdrop.remove()
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
    updateTabButtonsState()

    // Find mount container: second child of #flow-page-box
    const flowPageBox = document.getElementById('flow-page-box')
    const contentBox = flowPageBox?.children[1] as HTMLElement | null
    if (!contentBox) return

    if (!overlayEl) {
      overlayEl = document.createElement('div')
      overlayEl.id = OVERLAY_ID
      contentBox.appendChild(overlayEl)
    }
    overlayEl.style.display = 'flex'

    // Fetch Graph Data
    overlayEl.innerHTML = `
      <div class="vs-graph-toolbar">
        <div class="vs-graph-title-group">
          <span class="vs-graph-title">Loading Workflow Graph...</span>
        </div>
      </div>
      <div class="vs-graph-viewport" style="display:flex;align-items:center;justify-content:center;">
        <span style="color:#94a3b8;font-size:13px;">Analyzing flow dependencies and execution context...</span>
      </div>
    `

    const data = await bridge.getFlowGraphData()
    if (!isGraphActive) return

    if (!data) {
      overlayEl.innerHTML = `
        <div class="vs-graph-toolbar">
          <div class="vs-graph-title-group">
            <span class="vs-graph-title">Workflow Dependency Graph</span>
          </div>
          <div class="vs-graph-actions">
            <button class="vs-graph-btn vs-graph-close-btn" id="vs-graph-err-close">✕ Back to Flow</button>
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
    renderView()
  }

  function close(): void {
    isGraphActive = false
    updateTabButtonsState()
    if (overlayEl) {
      overlayEl.style.display = 'none'
    }
    hideTooltip()

    // Reselect Flow tab if none is selected
    const flowBtn = document.querySelector('[data-testid="workflow-flow-view-tab"]') as HTMLButtonElement | null
    if (flowBtn && !document.querySelector('.MuiToggleButtonGroup-root .Mui-selected')) {
      flowBtn.classList.add('Mui-selected')
      flowBtn.setAttribute('aria-pressed', 'true')
    }
  }

  function renderView(): void {
    if (!overlayEl || !currentGraphData) return

    const { trigger, steps, summary, timestamp } = currentGraphData

    overlayEl.innerHTML = `
      <div class="vs-graph-canvas-bg"></div>

      <!-- Top Toolbar -->
      <div class="vs-graph-toolbar">
        <div class="vs-graph-title-group">
          <span class="vs-graph-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="18" cy="5" r="3"></circle>
              <circle cx="6" cy="12" r="3"></circle>
              <circle cx="18" cy="19" r="3"></circle>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
            </svg>
            Dependency & Data Flow Graph
          </span>
          <span class="vs-graph-pill vs-graph-pill-run">
            ● ${timestamp ? `Run ${timestamp}` : 'Latest Run'}
          </span>
          <span class="vs-graph-pill vs-graph-pill-count">
            Total Steps: ${summary.totalSteps}
          </span>
          <span class="vs-graph-pill vs-graph-pill-dep">
            Dependent: ${summary.dependentSteps}
          </span>
          <span class="vs-graph-pill vs-graph-pill-indep">
            Independent: ${summary.independentSteps}
          </span>
        </div>

        <div class="vs-graph-filters">
          <button class="vs-graph-filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">All Steps</button>
          <button class="vs-graph-filter-btn ${currentFilter === 'dependent' ? 'active' : ''}" data-filter="dependent">Dependent Only</button>
          <button class="vs-graph-filter-btn ${currentFilter === 'independent' ? 'active' : ''}" data-filter="independent">Independent Only</button>
        </div>

        <div class="vs-graph-actions">
          <button class="vs-graph-btn" id="vs-zoom-out" title="Zoom Out">−</button>
          <span class="vs-graph-pill vs-graph-pill-count" id="vs-zoom-level">${Math.round(zoom * 100)}%</span>
          <button class="vs-graph-btn" id="vs-zoom-in" title="Zoom In">+</button>
          <button class="vs-graph-btn" id="vs-zoom-fit" title="Fit to Screen">⊡ Fit</button>
          <button class="vs-graph-btn" id="vs-zoom-reset" title="Reset View">⟲ Center</button>
          <button class="vs-graph-btn vs-graph-close-btn" id="vs-graph-close">✕ Back to Flow</button>
        </div>
      </div>

      <!-- Canvas Viewport -->
      <div class="vs-graph-viewport" id="vs-graph-viewport">
        <div class="vs-graph-transform-layer" id="vs-graph-transform-layer">
          <svg class="vs-graph-svg" id="vs-graph-svg">
            <defs>
              <filter id="vs-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur"></feGaussianBlur>
                <feComposite in="SourceGraphic" in2="blur" operator="over"></feComposite>
              </filter>
              <linearGradient id="vs-grad-cyan" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#38bdf8" />
                <stop offset="100%" stop-color="#818cf8" />
              </linearGradient>
              <linearGradient id="vs-grad-teal" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#2dd4bf" />
                <stop offset="100%" stop-color="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
          <div class="vs-graph-nodes-layer" id="vs-graph-nodes-layer"></div>
        </div>
      </div>
    `

    // Wire Toolbar Listeners
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
      pan = { x: 80, y: 60 }
      zoom = 1.0
      updateTransform()
    })
    overlayEl.querySelector('#vs-zoom-fit')?.addEventListener('click', fitView)

    // Wire Pan & Zoom on Viewport
    const viewport = overlayEl.querySelector('#vs-graph-viewport') as HTMLElement
    setupCanvasInteractions(viewport)

    // Render Nodes & Layout
    layoutAndRenderNodes()
    updateTransform()
  }

  function setZoom(newZoom: number, originX?: number, originY?: number): void {
    const clamped = Math.max(0.35, Math.min(2.0, newZoom))
    if (originX !== undefined && originY !== undefined) {
      // Zoom centered around origin
      const ratio = clamped / zoom
      pan.x = originX - (originX - pan.x) * ratio
      pan.y = originY - (originY - pan.y) * ratio
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
  }

  function setupCanvasInteractions(viewport: HTMLElement): void {
    viewport.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.vs-graph-card') || (e.target as HTMLElement).closest('.vs-graph-btn')) return
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

  function fitView(): void {
    const viewport = overlayEl?.querySelector('#vs-graph-viewport') as HTMLElement | null
    if (!viewport || !currentGraphData) return

    const rect = viewport.getBoundingClientRect()
    const padding = 80

    // Measure bounding box of all rendered cards
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
      const height = el.offsetHeight || 200
      minX = Math.min(minX, left)
      minY = Math.min(minY, top)
      maxX = Math.max(maxX, left + width)
      maxY = Math.max(maxY, top + height)
    }

    const graphWidth = maxX - minX
    const graphHeight = maxY - minY
    if (graphWidth <= 0 || graphHeight <= 0) return

    const scaleX = (rect.width - padding * 2) / graphWidth
    const scaleY = (rect.height - padding * 2) / graphHeight
    const targetZoom = Math.max(0.4, Math.min(1.2, Math.min(scaleX, scaleY)))

    zoom = targetZoom
    pan.x = (rect.width - graphWidth * zoom) / 2 - minX * zoom
    pan.y = (rect.height - graphHeight * zoom) / 2 - minY * zoom

    updateTransform()
  }

  function layoutAndRenderNodes(): void {
    if (!currentGraphData || !overlayEl) return
    const { trigger, steps } = currentGraphData
    const nodesLayer = overlayEl.querySelector('#vs-graph-nodes-layer') as HTMLElement
    nodesLayer.innerHTML = ''

    // Filter steps according to current filter
    let visibleSteps = steps
    if (currentFilter === 'dependent') {
      visibleSteps = steps.filter((s) => !s.isIndependent)
    } else if (currentFilter === 'independent') {
      visibleSteps = steps.filter((s) => s.isIndependent)
    }

    // Separate dependent from independent steps
    const dependentSteps = visibleSteps.filter((s) => !s.isIndependent)
    const independentSteps = visibleSteps.filter((s) => s.isIndependent)

    // Compute column layout for DAG (Left-to-Right)
    const COLUMN_WIDTH = 410
    const START_X = 60
    const START_Y = 60
    const CARD_GAP_Y = 40

    // Column 0: Trigger
    const columns: Map<number, FlowGraphNode[]> = new Map()
    if (trigger && currentFilter !== 'independent') {
      columns.set(0, [trigger])
    }

    // Assign dependent steps to columns by depth (1, 2, ...)
    for (const step of dependentSteps) {
      const col = Math.max(1, step.depth)
      const list = columns.get(col) || []
      list.push(step)
      columns.set(col, list)
    }

    let maxGraphY = START_Y

    // Render Dependent Columns
    for (const [colIndex, colNodes] of columns.entries()) {
      const colX = START_X + colIndex * COLUMN_WIDTH
      let currentY = START_Y

      for (const node of colNodes) {
        const card = createNodeCard(node)
        card.style.left = `${colX}px`
        card.style.top = `${currentY}px`
        nodesLayer.appendChild(card)

        const estimatedHeight = Math.max(180, (node.inputs.length + node.outputs.length) * 32 + 90)
        currentY += estimatedHeight + CARD_GAP_Y
      }

      maxGraphY = Math.max(maxGraphY, currentY)
    }

    // Render Independent Steps in a Dedicated Section below the DAG
    if (independentSteps.length > 0) {
      const indepSectionY = maxGraphY + 50
      const sectionWidth = Math.max(800, independentSteps.length * (COLUMN_WIDTH - 20) + 40)
      const sectionHeight = 360

      const lane = document.createElement('div')
      lane.className = 'vs-graph-independent-lane'
      lane.style.left = `${START_X}px`
      lane.style.top = `${indepSectionY}px`
      lane.style.width = `${sectionWidth}px`
      lane.style.height = `${sectionHeight}px`

      const label = document.createElement('div')
      label.className = 'vs-graph-lane-label'
      label.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        Independent Steps (0 dependencies on other steps — run standalone)
      `
      lane.appendChild(label)
      nodesLayer.appendChild(lane)

      let indepX = START_X + 24
      const indepY = indepSectionY + 28
      for (const step of independentSteps) {
        const card = createNodeCard(step)
        card.style.left = `${indepX}px`
        card.style.top = `${indepY}px`
        nodesLayer.appendChild(card)
        indepX += 360
      }
    }

    // After rendering cards into DOM, render SVG connection strings
    requestAnimationFrame(() => {
      renderConnections()
    })
  }

  function createNodeCard(node: FlowGraphNode): HTMLElement {
    const card = document.createElement('div')
    card.className = `vs-graph-card ${node.isIndependent ? 'is-independent' : ''} ${node.type === 'trigger' ? 'is-trigger' : ''}`
    card.setAttribute('data-node-id', node.id)

    // Header Icon & Title
    let iconClass = 'icon-plugin'
    let iconContent = 'P'
    if (node.type === 'trigger') {
      iconClass = 'icon-webhook'
      iconContent = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8h1a4 4 0 0 1 0 8h-1"></path>
          <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path>
          <line x1="6" y1="1" x2="6" y2="4"></line>
          <line x1="10" y1="1" x2="10" y2="4"></line>
          <line x1="14" y1="1" x2="14" y2="4"></line>
        </svg>
      `
    } else if (node.type === 'function') {
      iconClass = 'icon-js'
      iconContent = 'JS'
    } else if (node.iconUrl) {
      iconContent = `<img src="${node.iconUrl}" style="width:100%;height:100%;object-fit:cover;" />`
    }

    const typeLabel = node.type === 'trigger' ? 'Trigger' : node.type === 'function' ? 'JS' : 'Plugin'
    const depBadgeClass = node.isIndependent ? 'dep-independent' : 'dep-chain'
    const depBadgeText = node.type === 'trigger' ? 'Entry' : node.isIndependent ? 'Independent' : `Depth ${node.depth}`

    card.innerHTML = `
      <div class="vs-graph-card-header">
        <div class="vs-graph-card-title-box">
          <div class="vs-graph-card-icon ${iconClass}">
            ${iconContent}
          </div>
          <span class="vs-graph-card-name" title="${node.title}">${node.title}</span>
        </div>
        <div class="vs-graph-card-badges">
          <span class="vs-graph-type-badge">${typeLabel}</span>
          <span class="vs-graph-dep-badge ${depBadgeClass}">${depBadgeText}</span>
        </div>
      </div>
    `

    // Inputs Section (if any)
    if (node.inputs.length > 0) {
      const inSec = document.createElement('div')
      inSec.className = 'vs-graph-section'
      inSec.innerHTML = `<div class="vs-graph-section-header"><span>Inputs (With)</span></div>`

      const inList = document.createElement('div')
      inList.className = 'vs-graph-ports-list'

      for (const input of node.inputs) {
        const row = document.createElement('div')
        row.className = 'vs-graph-port-row'
        row.setAttribute('data-port-id', input.id)
        row.setAttribute('data-port-type', 'input')
        row.setAttribute('data-node-id', node.id)

        const dot = document.createElement('div')
        dot.className = 'vs-graph-port-dot port-in'
        dot.setAttribute('data-port-id', input.id)

        const key = document.createElement('span')
        key.className = 'vs-graph-port-key'
        key.title = input.expression || input.key
        key.innerText = input.key

        const dash = document.createElement('span')
        dash.className = 'vs-graph-port-dash'
        dash.innerText = '−'

        const val = document.createElement('span')
        val.className = 'vs-graph-port-val'
        val.title = `Click to inspect value: ${input.displayValue}`
        val.innerText = input.displayValue

        val.addEventListener('click', (e) => {
          e.stopPropagation()
          showDetailsModal(`${node.title} → Input: ${input.key}`, input.value)
        })

        row.appendChild(dot)
        row.appendChild(key)
        row.appendChild(dash)
        row.appendChild(val)

        // Hover highlight
        row.addEventListener('mouseenter', () => highlightPortAndCurves(input.id, 'input'))
        row.addEventListener('mouseleave', clearHighlights)

        inList.appendChild(row)
      }

      inSec.appendChild(inList)
      card.appendChild(inSec)
    }

    // Outputs Section (if any)
    if (node.outputs.length > 0) {
      const outSec = document.createElement('div')
      outSec.className = 'vs-graph-section'
      outSec.innerHTML = `<div class="vs-graph-section-header"><span>Outputs</span></div>`

      const outList = document.createElement('div')
      outList.className = 'vs-graph-ports-list'

      for (const output of node.outputs) {
        const row = document.createElement('div')
        row.className = 'vs-graph-port-row'
        row.setAttribute('data-port-id', output.id)
        row.setAttribute('data-port-type', 'output')
        row.setAttribute('data-node-id', node.id)

        const key = document.createElement('span')
        key.className = 'vs-graph-port-key'
        key.title = output.key
        key.innerText = output.key

        const dash = document.createElement('span')
        dash.className = 'vs-graph-port-dash'
        dash.innerText = '−'

        const val = document.createElement('span')
        val.className = 'vs-graph-port-val'
        val.title = `Click to inspect value: ${output.displayValue}`
        val.innerText = output.displayValue

        val.addEventListener('click', (e) => {
          e.stopPropagation()
          showDetailsModal(`${node.title} → Output: ${output.key}`, output.value)
        })

        const dot = document.createElement('div')
        dot.className = 'vs-graph-port-dot port-out'
        dot.setAttribute('data-port-id', output.id)

        row.appendChild(key)
        row.appendChild(dash)
        row.appendChild(val)
        row.appendChild(dot)

        // Hover highlight
        row.addEventListener('mouseenter', () => highlightPortAndCurves(output.id, 'output'))
        row.addEventListener('mouseleave', clearHighlights)

        outList.appendChild(row)
      }

      outSec.appendChild(outList)
      card.appendChild(outSec)
    }

    return card
  }

  function renderConnections(): void {
    if (!currentGraphData || !overlayEl) return
    const svg = overlayEl.querySelector('#vs-graph-svg') as SVGElement | null
    const transformLayer = overlayEl.querySelector('#vs-graph-transform-layer') as HTMLElement | null
    if (!svg || !transformLayer) return

    // Keep defs and clear old paths
    const defs = svg.querySelector('defs')
    svg.innerHTML = ''
    if (defs) svg.appendChild(defs)

    const layerRect = transformLayer.getBoundingClientRect()

    for (const conn of currentGraphData.connections) {
      // Find output port dot (source) and input port dot (target)
      const fromDot = transformLayer.querySelector(`.port-out[data-port-id="${conn.fromPortId}"]`)
      const toDot = transformLayer.querySelector(`.port-in[data-port-id="${conn.toPortId}"]`)

      if (!fromDot || !toDot) continue

      const fromRect = fromDot.getBoundingClientRect()
      const toRect = toDot.getBoundingClientRect()

      // Calculate relative coordinates inside transformLayer (divided by current zoom)
      const x1 = (fromRect.left + fromRect.width / 2 - layerRect.left) / zoom
      const y1 = (fromRect.top + fromRect.height / 2 - layerRect.top) / zoom
      const x2 = (toRect.left + toRect.width / 2 - layerRect.left) / zoom
      const y2 = (toRect.top + toRect.height / 2 - layerRect.top) / zoom

      // Smooth horizontal cubic Bézier curve
      const dx = Math.max(70, Math.abs(x2 - x1) * 0.5)
      const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', pathD)
      path.setAttribute('class', 'vs-graph-path')
      path.setAttribute('data-conn-id', conn.id)
      path.setAttribute('data-from-port', conn.fromPortId)
      path.setAttribute('data-to-port', conn.toPortId)
      path.setAttribute('stroke', conn.fromSlug === 'trigger' ? 'url(#vs-grad-cyan)' : 'url(#vs-grad-teal)')

      // Interactive hover on the curve itself
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
          overlayEl.querySelector(`.vs-graph-port-row[data-port-id="${fromPort}"]`)?.classList.add('highlighted-source')
          overlayEl.querySelector(`.port-out[data-port-id="${fromPort}"]`)?.classList.add('highlighted')
        }
        if (toPort) {
          overlayEl.querySelector(`.vs-graph-port-row[data-port-id="${toPort}"]`)?.classList.add('highlighted')
          overlayEl.querySelector(`.port-in[data-port-id="${toPort}"]`)?.classList.add('highlighted')
        }
      }
    }
  }

  function highlightConnectedPorts(fromPortId: string, toPortId: string): void {
    if (!overlayEl) return
    overlayEl.querySelector(`.vs-graph-port-row[data-port-id="${fromPortId}"]`)?.classList.add('highlighted-source')
    overlayEl.querySelector(`.port-out[data-port-id="${fromPortId}"]`)?.classList.add('highlighted')
    overlayEl.querySelector(`.vs-graph-port-row[data-port-id="${toPortId}"]`)?.classList.add('highlighted')
    overlayEl.querySelector(`.port-in[data-port-id="${toPortId}"]`)?.classList.add('highlighted')
  }

  function clearHighlights(): void {
    if (!overlayEl) return
    overlayEl.querySelectorAll('.vs-graph-path').forEach((p) => p.classList.remove('highlighted', 'pulse-anim'))
    overlayEl.querySelectorAll('.vs-graph-port-row').forEach((r) => r.classList.remove('highlighted', 'highlighted-source'))
    overlayEl.querySelectorAll('.vs-graph-port-dot').forEach((d) => d.classList.remove('highlighted'))
  }

  // Periodic check to ensure tab button exists whenever user navigates or DOM updates
  const interval = setInterval(ensureTabButton, 750)

  // Route change listener
  const onPopState = (): void => {
    if (isGraphActive) close()
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
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('resize', onResize)
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
