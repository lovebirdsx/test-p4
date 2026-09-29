/**
 * Vitest 夹具：每个测试文件拿一个独立的 p4d 实例。
 *
 * 隔离粒度选"文件"而不是"用例"：破坏性用例天然互不干扰，而同一文件内的用例共享
 * 一个实例可以让它们串起来讲一个完整故事（例如先提交、再回退、再校验）。
 * 需要每个用例都从干净基线开始时，在 `beforeEach` 里调 `sandbox.reset()`（约 1.5 秒）。
 */
import { test as base } from 'vitest';
import { Sandbox } from '../src/index.ts';

export interface SandboxFixtures {
  sandbox: Sandbox;
}

export const test = base.extend<SandboxFixtures>({
  sandbox: [
    async ({}, use) => {
      // 实例名只需在并行运行期间唯一即可（每个测试文件一个实例）
      const name = `sbx-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const sandbox = await Sandbox.start({ name });
      try {
        await use(sandbox);
      } finally {
        if (process.env.P4_KEEP_SANDBOX === '1') {
          console.log(
            [
              '',
              '── 保留现场（P4_KEEP_SANDBOX=1）──────────────────────',
              `  P4PORT    127.0.0.1:${sandbox.port}`,
              `  P4USER    ${sandbox.identity.user}`,
              `  P4CLIENT  ${sandbox.identity.client}`,
              `  工作区    ${sandbox.clientRoot}`,
              `  服务器根  ${sandbox.inst.root}`,
              '  可用 P4V 连接上述端口直接观察现场。',
              '──────────────────────────────────────────────────────',
              '',
            ].join('\n'),
          );
        } else {
          await sandbox.dispose();
        }
      }
    },
    { scope: 'file' },
  ],
});

export { expect } from 'vitest';
