/**
 * 可选的耗时观测。
 *
 * 沙箱的性能瓶颈是"p4.exe 子进程往返次数 × 串行次数"，因此观测也围绕两件事：
 * 各阶段的墙钟耗时，以及本次累计启动了**多少次 p4 子进程**。后者才是这个仓库
 * 的真正货币 —— 只要它没降，墙钟变快就多半是抖动。
 *
 * 默认完全关闭（`P4_SANDBOX_TIMING=1` 才启用），且只往 stderr 写一行汇总，
 * 不干扰测试输出。
 *
 * 命名注意：`P4_SANDBOX_TIMING` 会被 buildP4Env 大小写不敏感地删除，所以它
 * **不会**泄漏给 p4 子进程或被测工具。这是刻意的 —— 计时状态只属于父进程。
 * 也正因如此，不要把它加进 buildP4Env 的输出，否则 isolation 用例的白名单断言会红。
 */

const ENABLED = process.env.P4_SANDBOX_TIMING === '1';

/** 阶段累计耗时（毫秒），按首次出现顺序记录 */
const totals = new Map<string, number>();
let order: readonly string[] = [];
let spawns = 0;

/** 记一次 p4 子进程启动。关闭观测时是空操作。 */
export function noteSpawn(): void {
  if (ENABLED) spawns += 1;
}

/**
 * 开始一轮计数：清空阶段累计与 spawn 计数。
 *
 * 必须在每个观测作用域（`Sandbox.start` / `reset`）的**开头**调用。否则用例自身的
 * p4 调用会混进下一个作用域的 `p4-spawns` 里，那个数字就没法用来对账了。
 */
export function beginTiming(): void {
  if (!ENABLED) return;
  totals.clear();
  order = [];
  spawns = 0;
}

/** 计时并执行；关闭观测时直接执行，不引入额外开销 */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!ENABLED) return fn();
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    if (!totals.has(label)) order = [...order, label];
    totals.set(label, (totals.get(label) ?? 0) + (Date.now() - startedAt));
  }
}

/**
 * 打印本轮累计。
 * `scope` 里带上实例名，便于并行跑的多个文件在此区分。
 */
export function reportTiming(scope: string, totalMs: number): void {
  if (!ENABLED || order.length === 0) return;
  const phases = order.map((label) => `${label}=${totals.get(label)}ms`).join(' ');
  process.stderr.write(
    `[timing] ${scope} total=${totalMs}ms | ${phases} | p4-spawns=${spawns}\n`,
  );
}
