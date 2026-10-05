// Keep the existing deployment assertions, but host Miniflare's process/pipe
// lifecycle in Node. Bun 1.3.14 stalls with Broken pipe in these rollout tests on CI.
const { createRequire } = require('node:module');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const webRequire = createRequire(resolve('packages/prism-web/package.json'));
const viteRequire = createRequire(webRequire.resolve('vite'));
const { build } = viteRequire('esbuild');

const adapter = `
  import assert from 'node:assert/strict';
  import { test as nodeTest } from 'node:test';
  export const test = (name, fn, timeout = 30000) => nodeTest(name, {timeout}, fn);
  export function expect(value, message) {
    return {
      toBe: expected => assert.strictEqual(value, expected, message),
      toEqual: expected => assert.deepStrictEqual(value, expected, message),
      toBeNull: () => assert.strictEqual(value, null, message),
      toHaveLength: expected => assert.strictEqual(value.length, expected, message),
      toBeGreaterThan: expected => assert.ok(value > expected, message),
      toContain: expected => assert.ok(value.includes(expected), message),
      rejects: {toThrow: expected => assert.rejects(value, expected === undefined ? undefined
        : error => String(error.message).includes(expected), message)},
    };
  }
`;

async function main() {
  const file = process.argv[2];
  if (!['packages/platform/test/deployment-control.test.ts',
    'packages/platform/test/maintenance-worker.test.ts'].includes(file))
    throw new Error('Expected a supported deployment test file');
  const folder = mkdtempSync(resolve('.workerd-test-'));
  const output = join(folder, 'test.mjs');
  // Preserve test-relative migration/source URLs after bundling. This runtime
  // supplies only the Bun APIs used by these two files; business code is real.
  const sourceUrl = require('node:url').pathToFileURL(resolve(file)).href;
  const helpers = `
    import * as esbuild from ${JSON.stringify(require('node:url').pathToFileURL(viteRequire.resolve('esbuild')).href)};
    globalThis.Bun = { build: async options => {
      try {
        const result = await esbuild.build({entryPoints:options.entrypoints,bundle:true,write:false,
          format:'esm',platform:'browser',external:options.external,plugins:options.plugins});
        return {success:true,logs:[],outputs:result.outputFiles.map(file=>({text:async()=>file.text}))};
      } catch (error) { return {success:false,logs:[String(error)]}; }
    }};
  `;
  try {
    await build({entryPoints:[resolve(file)],bundle:true,write:true,outfile:output,
      platform:'node',format:'esm',external:['miniflare','node:*'],
      define:{'import.meta.url':JSON.stringify(sourceUrl)},banner:{js:helpers},
      plugins:[{name:'node-test-assertions',setup(builder) {
        builder.onResolve({filter:/^bun:test$/},()=>({path:'assertions',namespace:'node-test'}));
        builder.onLoad({filter:/.*/,namespace:'node-test'},()=>({contents:adapter,loader:'js'}));
      }}]});
    const result = spawnSync(process.execPath, ['--test', output], {stdio:'inherit',timeout:180000});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { rmSync(folder,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
