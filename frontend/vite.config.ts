import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      // 绑定文件位于 frontend 目录之外，从其位置向上找不到本项目的 node_modules，
      // 这里把运行时包显式指到 frontend/node_modules
      '@wailsio/runtime': fileURLToPath(
        new URL('./node_modules/@wailsio/runtime/dist/index.js', import.meta.url),
      ),
    },
  },
})
