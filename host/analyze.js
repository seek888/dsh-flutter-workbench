/**
 * STUB — owner: dev-toolchain. Replaced by the real implementation.
 * analyze / test / pub get / clean / build / doctor / format / devices.
 */
export function createToolchain() {
  const unavailable = () => {
    throw Object.assign(new Error('toolchain module not implemented yet'), { code: 'not-implemented' })
  }
  return {
    analyze: unavailable,
    test: unavailable,
    pubGet: unavailable,
    clean: unavailable,
    build: unavailable,
    doctor: unavailable,
    format: unavailable,
    devices: async () => [],
    emulators: async () => [],
    resolvePaths: () => ({ flutterPath: 'flutter', dartPath: 'dart', source: 'PATH' }),
  }
}