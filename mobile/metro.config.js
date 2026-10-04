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

// Without this, Metro walks up the directory tree on every miss and can pick up a
// different copy of react from the workspace root — two Reacts in one bundle, which
// shows up as a hook error far from its cause.
config.resolver.disableHierarchicalLookup = true

module.exports = config
