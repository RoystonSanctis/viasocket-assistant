// Read access to selectors.json with per-key fallbacks. Selectors come from the (trusted) config repo or from
// extension code; values derived from LLM output are only ever used as lookup keys or CSS-escaped fragments.

import type { SelectorsConfig } from '../../shared/config'
import { DEFAULT_SELECTORS } from './defaults'

export class Selectors {
  private cfg: SelectorsConfig = DEFAULT_SELECTORS

  set(cfg: SelectorsConfig): void {
    this.cfg = cfg
  }

  flow(key: string): string | undefined {
    return own(this.cfg.flow, key) ?? own(DEFAULT_SELECTORS.flow, key)
  }

  devHub(key: string): string | undefined {
    return own(this.cfg.devHub, key) ?? own(DEFAULT_SELECTORS.devHub, key)
  }

  /** A named, non-template selector from either group (template keys like stepNode are not usable alone) */
  named(key: string): string | undefined {
    const sel = this.flow(key) ?? this.devHub(key)
    return sel && !sel.includes('{') ? sel : undefined
  }

  avoid(): string[] {
    return unique([...this.cfg.avoid, ...DEFAULT_SELECTORS.avoid])
  }

  fieldContainers(): string[] {
    return unique([...this.cfg.fieldLabel.containers, ...DEFAULT_SELECTORS.fieldLabel.containers])
  }

  fieldLabels(): string[] {
    return unique([...this.cfg.fieldLabel.labels, ...DEFAULT_SELECTORS.fieldLabel.labels])
  }
}

function own(rec: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined
}

function unique(list: string[]): string[] {
  return [...new Set(list.filter((s) => s.trim().length > 0))]
}

/** querySelector that tolerates a broken selector from config instead of throwing */
export function queryOne(sel: string | undefined, root: ParentNode = document): Element | null {
  if (!sel) return null
  try {
    return root.querySelector(sel)
  } catch {
    return null
  }
}

export function queryAll(sel: string | undefined, root: ParentNode = document): Element[] {
  if (!sel) return []
  try {
    return Array.from(root.querySelectorAll(sel))
  } catch {
    return []
  }
}
