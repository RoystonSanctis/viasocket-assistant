// Only js-beautify's JavaScript beautifier is bundled (the package's main entry would also pull in its CSS and HTML
// beautifiers). These deep paths are CommonJS modules without bundled types; esbuild handles the interop.

declare module 'js-beautify/js/src/javascript/index.js' {
  const jsBeautify: (source: string, options?: Record<string, unknown>) => string
  export default jsBeautify
}

declare module 'js-beautify/js/src/javascript/options.js' {
  export class Options {
    constructor(options?: Record<string, unknown>)
  }
}

declare module 'js-beautify/js/src/javascript/tokenizer.js' {
  interface Token {
    type: string
    text: string
    /** Line breaks between this token and the previous one */
    newlines: number
    /** Comments that sit between the previous token and this one */
    comments_before: TokenStream | null
  }
  interface TokenStream {
    restart(): void
    hasNext(): boolean
    next(): Token
  }
  export class Tokenizer {
    constructor(source: string, options: unknown)
    tokenize(): TokenStream
  }
}
