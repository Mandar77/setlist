/**
 * The app entry point.
 *
 * `registerRootComponent` is Expo's `AppRegistry.registerComponent` plus the bits that
 * make a development build attach correctly. Kept as the only thing in this file so the
 * entry point never becomes somewhere logic accumulates.
 */

import { registerRootComponent } from 'expo'

import App from './src/App'

registerRootComponent(App)
