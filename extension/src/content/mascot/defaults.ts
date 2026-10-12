// Used until the first config arrives from the service worker, and per key when the config lacks one,
// so the mascot still behaves sensibly with a stale or partial selectors.json.

import type { MascotConfig, SelectorsConfig } from '../../shared/config'

export const DEFAULT_SELECTORS: SelectorsConfig = {
  schemaVersion: 1,
  appHosts: [],
  flow: {
    canvasViewport: '[data-testid="flow-canvas"]',
    zoomContainer: '[data-testid="flow-zoom-container"]',
    stepNode: '[data-testid="step-node-{slugName}"]',
    triggerNode: '[data-testid^="inflow-node-"]',
    stepPanel: '[data-testid="step-config-slider"]',
    stepSave: '[data-testid="save-button"]',
    stepTest: '[data-testid="dry-run-test-button"]',
    publishButton: '[data-testid="publish-go-live-button"]',
    discardButton: '[data-testid="publish-discard-changes-button"]',
    controls: '[data-testid="flow-controls-container"]',
    askAiButton: '[data-testid="ask-ai-button"]',
    zoomFitButton: '[data-testid="zoom-fit-button"]',
    navbar: '[data-testid="workflow-navbar-container"]',
  },
  devHub: {
    section: '.dynamic-section',
    saveButton:
      '[data-testid="dh-save-button"], [data-testid="dh-save-input-fields-button"], [data-testid="plugin-details-save-button"]',
    dryRunButton:
      '[data-testid="dry-run-test-button"], [data-testid="dh-dry-run-test-button"], [data-testid="function-slider-test-button"]',
  },
  fieldLabel: {
    containers: ['[data-testid="step-config-slider"]', '.dynamic-section'],
    labels: ['[data-testid^="plugin-field-label-"]'],
  },
  avoid: [
    '[data-testid="toast-alert"]',
    '[data-testid="support-menu"]',
    '[data-testid="support-chatbot-panel"]',
    '[data-testid="action-chat-button"]',
    '[data-testid="flow-page-open-chat-button"]',
    '[data-testid="build-flow-card"]',
    '.search-panel-container',
    '#parentChatbot',
    '#parentConnectionChatbot',
    '#fbaiparentChatbot',
    '#gtwy-embed-container',
    // Canvas nodes and controls other than plain steps, and dialogs/popovers that open over the canvas
    '[data-testid^="delay-step-node-"]',
    '[data-testid^="if-component-"]',
    '[data-testid^="break-component-"]',
    '[data-testid="add-step-button"]',
    '[data-testid="vertical-stick-add-step"]',
    '[data-testid="build-with-ai-card"]',
    '[data-testid="select-trigger-prompt"]',
    '[data-testid="ai-first-empty-state"]',
    '.MuiDialog-container [role="dialog"]',
    '.MuiPopover-paper',
    '[data-testid="publish-success-snackbar"]',
  ],
}

export const DEFAULT_MASCOT: MascotConfig = {
  schemaVersion: 1,
  size: 44,
  roam: { enabled: true, speed: 0.015, restSeconds: [4, 12], sleepAfterSeconds: 45 },
  colors: {
    idle: '#5DCAA5',
    waking: '#5DCAA5',
    happy: '#5DCAA5',
    curious: '#EF9F27',
    listening: '#F0997B',
    thinking: '#AFA9EC',
    searching: '#AFA9EC',
    working: '#85B7EB',
    suggest: '#EF9F27',
    confused: '#F09595',
    celebrate: '#97C459',
    sleeping: '#B4B2A9',
  },
  lines: {},
  reactions: [],
  thinkingTextMaxChars: 60,
}
