import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 首次运行需要在 globalSetup 里 seed 一份基线模板
    globalSetup: ['./test/global-setup.ts'],
    // 每个测试文件会从模板复制一份独立沙箱并启动 p4d
    hookTimeout: 120_000,
    testTimeout: 30_000,
    pool: 'forks',
    // 实例之间完全独立（独立 root / 端口 / 工作区），可安全并行
    fileParallelism: true,
  },
});
