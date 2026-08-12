import { build } from 'esbuild';

await build({
    entryPoints: ['server/index.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: 'dist/server-plugin.mjs',
    legalComments: 'inline',
    banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
});
