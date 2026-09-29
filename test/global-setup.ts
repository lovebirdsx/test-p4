/**
 * vitest 全局初始化：保证模板存在。
 *
 * 模板生成需要跑一次完整的 seed，放在这里可以只跑一次，并避免多个测试文件并行
 * 启动时同时去 seed 同一份模板。
 */
import { ensureTemplate } from '../src/index.ts';

export default async function setup(): Promise<void> {
  await ensureTemplate();
}
