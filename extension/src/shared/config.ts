// Schema for the remotely managed config (the separate GitHub "config" repo).
// Everything here is declarative data. Chrome Web Store forbids remotely hosted code, so the config can only
// tune prompts, wording, selectors, models and switches; behaviour stays in the reviewed extension code.

import * as z from './zod'

export const CONFIG_SCHEMA_VERSION = 1

const semver = z.string().regex(/^\d+\.\d+\.\d+$/)

export const configManifestSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  configVersion: z.string().min(1),
  minExtensionVersion: semver,
  files: z.object({
    providers: z.string(),
    selectors: z.string(),
    mascot: z.string(),
    flags: z.string(),
    tools: z.string(),
    voice: z.string(),
    prompts: z.object({
      system: z.string(),
      flowBuilder: z.string(),
      devHub: z.string(),
      reactions: z.string(),
    }),
  }),
})

// Header names the config may ask us to send. Anything else is dropped so config cannot smuggle auth headers.
export const ALLOWED_EXTRA_HEADERS = ['HTTP-Referer', 'X-Title'] as const

export const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  adapter: z.enum(['openai', 'anthropic']),
  /**
   * Only for providers that are NOT built into the extension. Built-in providers ignore this and use the
   * address compiled into the code, so a compromised config repo can never redirect a saved key.
   */
  baseUrl: z.string().url().optional(),
  keyPattern: z.string().optional(),
  keyPageUrl: z.string().url().optional(),
  validatePath: z.string().optional(),
  modelsPath: z.string().optional(),
  noKey: z.boolean().optional(),
  badges: z.array(z.string()).optional(),
  setupTip: z.string().optional(),
  recommendedModels: z.array(z.string()).optional(),
  requires: z.array(z.enum(['tools'])).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
})
export type ProviderConfig = z.infer<typeof providerSchema>

export const providersFileSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  providers: z.array(providerSchema),
})

export const selectorsFileSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  /** Hosts where the mascot runs (the viaSocket app, not the marketing site) */
  appHosts: z.array(z.string()),
  flow: z.record(z.string(), z.string()),
  devHub: z.record(z.string(), z.string()),
  fieldLabel: z.object({
    containers: z.array(z.string()),
    labels: z.array(z.string()),
  }),
  /** Floating UI the mascot must never cover (e.g. the GTWY chatbot) */
  avoid: z.array(z.string()),
})
export type SelectorsConfig = z.infer<typeof selectorsFileSchema>

const mascotModeEnum = z.enum([
  'idle', 'listening', 'thinking', 'searching', 'working', 'suggest',
  'confused', 'celebrate', 'sleeping', 'waking', 'happy', 'curious',
])

export const reactionSchema = z.object({
  on: z.enum([
    'flow-loaded', 'step-saved', 'step-created', 'step-deleted', 'step-tested', 'trigger-saved',
    'flow-published', 'flow-discarded', 'dh-saved', 'dh-dry-run', 'api-error', 'unknown-mutation',
  ]),
  when: z.object({ ok: z.boolean().optional(), byAssistant: z.boolean().optional() }).optional(),
  mood: mascotModeEnum,
  say: z.string().optional(),
  /** 'step' highlights the step the event was about; anything else is a selectors.json key */
  highlight: z.string().optional(),
  /** Offer an "Explain" button that asks the LLM (costs one request) */
  offerExplain: z.boolean().optional(),
  minLevel: z.enum(['quiet', 'helpful', 'proactive']).default('helpful'),
  cooldownSeconds: z.number().min(0).default(20),
})
export type ReactionConfig = z.infer<typeof reactionSchema>

export const mascotFileSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  size: z.number().min(24).max(96).default(44),
  roam: z.object({
    enabled: z.boolean().default(true),
    speed: z.number().min(0.002).max(0.2).default(0.015),
    restSeconds: z.tuple([z.number(), z.number()]).default([4, 12]),
    sleepAfterSeconds: z.number().default(45),
  }),
  colors: z.record(mascotModeEnum, z.string()),
  lines: z.record(z.string(), z.string()),
  reactions: z.array(reactionSchema),
  thinkingTextMaxChars: z.number().default(60),
})
export type MascotConfig = z.infer<typeof mascotFileSchema>

export const flagsFileSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  maxAgentSteps: z.number().int().min(1).max(60).default(24),
  maxToolResultChars: z.number().int().min(500).max(60000).default(12000),
  conversationMaxMessages: z.number().int().min(4).max(200).default(40),
  defaultProactivity: z.enum(['quiet', 'helpful', 'proactive']).default('helpful'),
  enableDevHub: z.boolean().default(true),
  enableTriggerTools: z.boolean().default(true),
  /** Tools that always ask the user first, on top of the ones the code already marks as dangerous */
  alwaysConfirm: z.array(z.string()).default([]),
  /** Remove run/sample data (customer emails, payloads) from flow JSON before it is sent to the LLM */
  stripRunData: z.boolean().default(true),
  disabled: z.boolean().default(false),
  disabledMessage: z.string().optional(),
})
export type FlagsConfig = z.infer<typeof flagsFileSchema>

export const toolsFileSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  tools: z.record(z.string(), z.object({
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })),
})
export type ToolsConfig = z.infer<typeof toolsFileSchema>

export const voiceFileSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  stt: z.object({
    defaultEngine: z.enum(['whisper-local', 'browser']),
    defaultModel: z.string(),
    models: z.array(z.object({
      id: z.string(),
      label: z.string(),
      approxSizeMb: z.number(),
      multilingual: z.boolean(),
      note: z.string().optional(),
    })),
    /** Words the transcript is fuzzy-corrected towards (app names that small models mishear) */
    vocabulary: z.array(z.string()).default([]),
  }),
  tts: z.object({
    enabled: z.boolean().default(true),
    rate: z.number().min(0.5).max(2).default(1.05),
    pitch: z.number().min(0).max(2).default(1.1),
    maxChars: z.number().default(160),
  }),
  hotkey: z.object({
    holdMs: z.number().default(180),
  }),
})
export type VoiceConfig = z.infer<typeof voiceFileSchema>

export interface PromptSet {
  system: string
  flowBuilder: string
  devHub: string
  reactions: string
}

export interface FullConfig {
  configVersion: string
  source: 'remote' | 'cache' | 'bundled'
  channel: string
  loadedAt: number
  providers: ProviderConfig[]
  selectors: SelectorsConfig
  mascot: MascotConfig
  flags: FlagsConfig
  tools: ToolsConfig
  voice: VoiceConfig
  prompts: PromptSet
}

/** The subset the content script needs. Prompts and provider details stay in the service worker. */
export interface ClientConfig {
  configVersion: string
  selectors: SelectorsConfig
  mascot: MascotConfig
  voice: VoiceConfig
  flags: Pick<FlagsConfig, 'defaultProactivity' | 'enableDevHub' | 'disabled' | 'disabledMessage'>
}

export function toClientConfig(c: FullConfig): ClientConfig {
  return {
    configVersion: c.configVersion,
    selectors: c.selectors,
    mascot: c.mascot,
    voice: c.voice,
    flags: {
      defaultProactivity: c.flags.defaultProactivity,
      enableDevHub: c.flags.enableDevHub,
      disabled: c.flags.disabled,
      disabledMessage: c.flags.disabledMessage,
    },
  }
}
