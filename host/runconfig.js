/**
 * STUB — owner: dev-runner. Replaced by the real implementation.
 * Project/config discovery for Flutter projects.
 */
const EMPTY_DETECTED = { ok: false, appName: null, description: null, platforms: [], flavors: [], sdkConstraint: null, error: 'not implemented' }

export async function detectFlutterProject() {
  return { ...EMPTY_DETECTED }
}

export function parseLaunchJson() {
  return { version: undefined, configurations: [] }
}

export function normalizeLaunchConfigs() {
  return []
}

export async function discoverEntryPoints() {
  return []
}

export async function listDevices() {
  return []
}

export async function listEmulators() {
  return []
}

export async function readFlavors() {
  return []
}

export async function discoverConfigs() {
  return { configs: [], entries: [], devices: [], emulators: [], flavors: [], launchFile: null, warnings: ['runconfig module not implemented'] }
}