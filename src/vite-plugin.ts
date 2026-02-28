/**
 * Vite plugin that stubs Node.js-only transitive dependencies from
 * @mariozechner/pi-ai's Bedrock provider.
 *
 * pi-ai's register-builtins.js statically imports amazon-bedrock.js which
 * statically imports @aws-sdk/client-bedrock-runtime. That SDK pulls in
 * @smithy/node-http-handler and other Node.js-only packages (http, https,
 * http2, stream, node:fs). These break browser/WebView bundling.
 *
 * Usage in a consumer's vite.config:
 *
 *   import { mobileClawVitePlugin } from 'capacitor-mobile-claw/vite-plugin'
 *
 *   export default defineConfig({
 *     plugins: [mobileClawVitePlugin(), vue()],
 *   })
 */

const STUB_IDS = [
  '@aws-sdk/client-bedrock-runtime',
  '@smithy/node-http-handler',
  '@smithy/hash-node',
  '@smithy/eventstream-serde-node',
  '@smithy/util-body-length-node',
  '@smithy/util-defaults-mode-node',
  '@smithy/node-config-provider',
  '@smithy/shared-ini-file-loader',
  'proxy-agent',
  'undici',
]

// A module that uses a Proxy as the default export and marks it with
// syntheticNamedExports so Rollup resolves ANY named import from the stub.
const STUB_MODULE = [
  'const handler = { get: () => undefined };',
  'const stub = new Proxy({}, handler);',
  'export default stub;',
].join('\n')

export function mobileClawVitePlugin() {
  return {
    name: 'mobile-claw-stub-node-deps',
    enforce: 'pre' as const,

    resolveId(source: string) {
      if (STUB_IDS.includes(source)) {
        return { id: `\0stub:${source}`, syntheticNamedExports: true }
      }
      return null
    },

    load(id: string) {
      if (id.startsWith('\0stub:')) {
        return STUB_MODULE
      }
      return null
    },
  }
}
