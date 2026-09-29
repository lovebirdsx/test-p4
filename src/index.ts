/**
 * 对外导出的公开 API。
 *
 * 典型用法（测试或外部工具）：
 * ```ts
 * import { Sandbox } from '../src/index.ts';
 * const sandbox = await Sandbox.start({ name: 'my-case' });
 * const result = await sandbox.p4.run(['changes', '-m', '5']);
 * await sandbox.dispose();
 * ```
 */
export * from './paths.ts';
export * from './env.ts';
export * from './exec.ts';
export * from './parse.ts';
export * from './p4d.ts';
export * from './seed.ts';
export * from './sandbox.ts';
