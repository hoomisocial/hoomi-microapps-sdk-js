import { defineConfig } from 'vite';

// Single-entry IIFE global build (window.Hoomi) for micro-apps that ship a
// plain <script> tag instead of a bundler. Separate config on purpose: Vite
// rejects multi-entry lib builds when 'iife' is among the formats.
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: true,
    emptyOutDir: false,
    lib: {
      entry: 'src/global.ts',
      name: 'Hoomi',
      formats: ['iife'],
      fileName: () => 'hoomi.microapps.global.js',
    },
  },
});
