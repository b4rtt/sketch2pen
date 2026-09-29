// Bun embeds files imported `with { type: 'file' }` and resolves them to a readable path.
declare module '*.wasm' {
  const path: string;
  export default path;
}
