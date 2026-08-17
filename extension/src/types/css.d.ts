/**
 * CSS imported as a string.
 *
 * The build uses esbuild's `text` loader for `.css` so the panel can inject its
 * stylesheet into a shadow root at runtime (see scripts/build.mjs). This tells
 * TypeScript what that import yields.
 */
declare module '*.css' {
  const content: string;
  export default content;
}
