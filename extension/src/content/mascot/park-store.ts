// Where the user parked the mascot, per page kind. Stored as fractions of the viewport so a resized window
// keeps the same corner.

import type { PageKind } from '../../shared/page'

const KEY = 'mascotPark'

export interface ParkSpot {
  rx: number
  ry: number
}

type ParkMap = Partial<Record<PageKind, ParkSpot>>

function isSpot(v: unknown): v is ParkSpot {
  if (typeof v !== 'object' || v === null) return false
  const { rx, ry } = v as Record<string, unknown>
  return typeof rx === 'number' && typeof ry === 'number' && rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1
}

async function readMap(): Promise<ParkMap> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return {}
  try {
    const raw = (await chrome.storage.local.get(KEY))[KEY]
    return typeof raw === 'object' && raw !== null ? { ...(raw as ParkMap) } : {}
  } catch {
    return {}
  }
}

export async function loadPark(kind: PageKind): Promise<ParkSpot | null> {
  try {
    const spot = (await readMap())[kind]
    return isSpot(spot) ? spot : null
  } catch {
    // Extension context invalidated (extension reloaded under an open tab): just don't remember.
    return null
  }
}

export async function savePark(kind: PageKind, spot: ParkSpot | null): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return
    const map = await readMap()
    if (spot) map[kind] = spot
    else delete map[kind]
    await chrome.storage.local.set({ [KEY]: map })
  } catch {
    /* see loadPark */
  }
}
