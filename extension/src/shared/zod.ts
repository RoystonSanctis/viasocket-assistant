// Extension CSP forbids eval. Without jitless, zod probes `new Function` when the first object schema
// is built, which Chrome reports as a CSP violation. Import zod as `import * as z from '<path>/shared/zod'`
// (never from 'zod' directly) so this runs before any schema exists; the namespace form keeps tree-shaking.
import { config } from 'zod'

config({ jitless: true })

export * from 'zod'
