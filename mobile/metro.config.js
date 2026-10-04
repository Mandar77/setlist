// Metro, taught about the pnpm workspace.
//
// The default config assumes node_modules sits beside the app. pnpm puts almost nothing
// there — dependencies are symlinks into a content-addressed store at the workspace root
// — so without this the bundler resolves `expo` and `react-native` fine (they are
// hoisted into mobile/node_modules) and then fails on `@setlist/core`, which is a
// workspace link pointing up and out of the project root.
//
// That failure is worth naming because of how it presents: the app builds, installs, and
// crashes on launch with a module-not-found for the one package the whole screen is
// about.

const path = require('node:path')

const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Watch the whole workspace so a change in packages/core reaches the bundler.
config.watchFolders = [workspaceRoot]

// Look in both module trees. The order matters: the app's own resolutions win.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Hierarchical lookup stays ON, and that is the opposite of what a hoisted npm layout
// usually wants.
//
// The first version set `disableHierarchicalLookup = true` to stop Metro finding a second
// copy of react. With pnpm that is precisely wrong: a package's dependencies live beside
// it under `.pnpm/<pkg>@<version>/node_modules/`, so resolving `expo-modules-core` from
// `expo/src/Expo.ts` REQUIRES walking up from that file. Turning it off broke the release
// bundle with "Unable to resolve module expo-modules-core", which reads like a missing
// dependency and is actually a resolver that was told not to look.
//
// The duplicate-react worry does not apply here anyway: one react version is resolved for
// the whole workspace, so there is no second copy to find.

// `./confidence.js` means `./confidence.ts`, and only TypeScript knows that.
//
// `packages/core` is compiled with `module: NodeNext`, which requires every relative
// import to carry the extension of the file as it will exist at RUNTIME — so the source
// says `export * from './confidence.js'` while the file on disk is `confidence.ts`. Node
// and tsc both understand that; Metro does not, and looks for a literal `confidence.js`
// that has never existed.
//
// It matters here and nowhere else because ADR-001 has the app consume the core as
// TypeScript source rather than as build output — one grammar, compiled by whatever
// bundles it. The alternative would be pointing the app at `packages/core/dist`, which
// would mean the device runs a different artifact from the one the tests run, and that is
// the thing ADR-001 exists to prevent.
//
// So: for a relative specifier ending in `.js`, try the extensionless form first and fall
// back to the original, which keeps genuine `.js` files resolving normally.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -'.js'.length), platform)
    } catch {
      // Not a TypeScript source after all — fall through to the normal resolution.
    }
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
