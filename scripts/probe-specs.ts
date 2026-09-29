/**
 * 开发辅助：起一个临时沙箱，把服务器上各类 spec 的**默认结构**原样打出来。
 *
 * 新增夹具（label / trigger / group / stream …）时，先用它查清楚字段名再写表单，
 * 比反复试错快得多 —— 本工程的 seed.ts 就是这么确定出
 * 「user spec 没有 Description 字段」「typemap 的字段名是 TypeMap」这类事实的。
 *
 *   node scripts/probe-specs.ts               # 全部
 *   node scripts/probe-specs.ts label group   # 只看指定的几项
 */
import { P4dServer, removeInstance, tempInstancePaths, type P4Cli } from '../src/index.ts';

/** 每项探测 = 一组 p4 参数（不含全局选项，由 P4Cli 注入沙箱端口） */
const PROBES: Record<string, readonly string[]> = {
  info: ['info'],
  user: ['user', '-o', 'sandbox'],
  client: ['client', '-o', 'sandbox_main'],
  depot: ['depot', '-o', 'depot'],
  typemap: ['typemap', '-o'],
  label: ['label', '-o'],
  branch: ['branch', '-o'],
  group: ['group', '-o'],
  triggers: ['triggers', '-o'],
  protections: ['protect', '-o'],
  jobspec: ['jobspec', '-o'],
};

async function probe(p4: P4Cli, name: string, args: readonly string[]): Promise<void> {
  const result = await p4.run(args, { format: 'text', allowFailure: true });
  console.log(`\n${'='.repeat(20)} ${name}（p4 ${args.join(' ')}，退出码 ${result.exitCode}）${'='.repeat(20)}`);
  console.log((result.stdout || result.stderr).trim());
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(PROBES);

const unknown = names.filter((n) => !(n in PROBES));
if (unknown.length > 0) {
  console.error(`未知的探测项：${unknown.join(', ')}`);
  console.error(`可选：${Object.keys(PROBES).join(' / ')}`);
  process.exit(2);
}

const inst = tempInstancePaths('__probe__');
await removeInstance(inst);

// 临时实例只做只读探测，不需要完整 seed
const server = await P4dServer.start({ inst });
try {
  for (const name of names) {
    const args = PROBES[name];
    if (args) await probe(server.p4, name, args);
  }
} finally {
  await server.stop();
  await removeInstance(inst);
}
