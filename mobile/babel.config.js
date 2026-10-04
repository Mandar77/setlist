// `babel-preset-expo` is what turns TypeScript and JSX into something Hermes runs, and
// it is also what applies the Hermes-specific transforms the engine needs.
//
// It matters here beyond the app's own files: `@setlist/core` is consumed as TypeScript
// source — its package exports point at `./src/index.ts` — so the preset is what compiles
// the shared grammar too. One preset, one set of transforms, the same code on the device
// as in the Lambdas.

module.exports = function babelConfig(api) {
  api.cache(true)
  return { presets: [['babel-preset-expo', { jsxRuntime: 'automatic' }]] }
}
