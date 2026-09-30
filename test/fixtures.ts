/**
 * Vitest 夹具：每个测试文件拿一个独立的 p4d 实例。
 *
 * 隔离粒度选"文件"而不是"用例"：同一文件内的用例共享一个实例，可以把它们串起来
 * 讲一个完整故事（例如先提交、再回退、再校验）。
 *
 * **会改动实例状态的用例请让它独占一个文件**，而不是在同一文件里靠 `reset()` 反复回到基线：
 * 每个文件本来就是从模板复制出来的干净基线，独占文件等于免费拿到一次重置，而文件之间是
 * 并行的。反过来，把多个破坏性用例塞进一个文件、每个开头都 reset 一次，会让它们退化成
 * 串行 —— 拆分前的 `reset-recovery.test.ts` 就是这样，一个文件吃掉了整套测试 97% 的墙钟。
 *
 * 同文件内用 `reset()` 只在两种情况下才划算：验证 reset 行为本身，或用例确实要回到中途
 * 某个基线。一次约 0.5 秒（详见 docs/design.md 的"性能"一节）。
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
