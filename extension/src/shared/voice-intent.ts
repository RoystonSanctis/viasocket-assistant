// Voice intent parsing for confirmation cards and conversation exit commands

export function isVoiceExit(text: string): boolean {
  const norm = text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim()
  return (
    /^(?:stop|exit|bye|goodbye|quit|cancel|stop\s*listening|shut\s*up|quiet|sleep|that'?s\s*all|done|nothing|no\s*more|close)$/i.test(norm) ||
    /^(?:stop|exit|cancel)\s+(?:listening|voice|talking|it)$/i.test(norm) ||
    /^(?:thank\s*you|thanks)(?:\s+(?:very\s*much|so\s*much))?(?:\s+(?:that'?s\s*all|bye|goodbye))?$/i.test(norm)
  )
}

export function parseConfirmIntent(text: string, confirmLabel?: string): boolean | null {
  const norm = text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim()

  // Rejection / Cancel
  if (
    /^(?:cancel|cancelled|no|nope|nah|don't|dont|stop|abort|never\s*mind|nevermind|leave\s*it|nahi|mat\s*karo|chhod\s*do|reject)$/i.test(norm) ||
    /\b(?:don't\s*(?:do\s*it|discard|delete|publish)|do\s*not|cancel\s*it)\b/i.test(norm)
  ) {
    return false
  }

  // Confirmation / Proceed
  if (
    /^(?:confirm|confirmed|yes|yeah|yep|yup|sure|ok|okay|proceed|continue|do\s*it|go\s*ahead|haan|haanji|theek\s*hai|sahi\s*hai|agree|approve|approved)$/i.test(norm) ||
    /\b(?:yes\s*(?:please|confirm|do\s*it|proceed)|confirm\s*it|go\s*for\s*it)\b/i.test(norm)
  ) {
    return true
  }

  if (confirmLabel) {
    const labelNorm = confirmLabel.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim()
    if (labelNorm && norm === labelNorm) {
      return true
    }
  }

  return null
}

