import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// ESM + CJS multi-entry library build.
// The IIFE global build lives in vite.iife.config.ts because Vite (correctly)
// rejects multi-entry lib builds when the format list includes 'iife'.
export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      outDir: 'dist',
    }),
  ],
  build: {
    // es2022 keeps native #private class fields: the es2020 WeakMap
    // downleveling defeats consumer-side tree-shaking (WeakMap construction
    // is not provably pure), which blows the errors-only import up to the
    // whole client.
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        react: 'src/react/index.ts',
        mock: 'src/mock/index.ts',
        testing: 'src/testing/index.ts',
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom'],
      // Explicit per-format outputs so shared chunks get the right extension:
      // this package is type:module, so a CJS chunk emitted as .js would be
      // mis-parsed as ESM by Node.
      output: [
        {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
        {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
          exports: 'named',
        },
      ],
    },
  },
});
