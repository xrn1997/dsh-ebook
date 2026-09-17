import { defineConfig } from 'vitest/config'

// 构建产物自检集（先 pnpm build；常规 vitest.config.ts 已 exclude 本文件）
export default defineConfig({
  test: {
    include: ['tests/packaging-build.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],   // 与常规集同口径：临时目录登记簿统一回收（该文件暂未用，防将来滥用）
  },
})
