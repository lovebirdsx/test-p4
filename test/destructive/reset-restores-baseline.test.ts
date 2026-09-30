/**
 * reset 的核心保证：破坏性操作之后回到基线。
 *
 * 单独占一个文件是因为它要改动实例状态 —— 隔离粒度是**文件**，同文件内的用例会共享
 * 一个实例。新实例本身就是干净基线，所以开头不需要再 reset 一次（这是拆分掉
 * `reset-recovery.test.ts` 之后省下来的主要开销）。
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { latestChangeNumber, readWsFile, submitAll, wsPath, writeWsFile } from '../helpers.ts';

describe('reset：破坏后回到基线', () => {
  test('提交额外 changelist + 删文件后，reset 回到基线', async ({ sandbox }) => {
    const baseline = await latestChangeNumber(sandbox);

    // 破坏一：提交一个基线里不存在的 changelist
    await sandbox.p4.run(['edit', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await writeWsFile(sandbox, 'src/util.txt', '被破坏的内容\n');
    const dirty = await submitAll(sandbox, '破坏性实验：额外提交');
    expect(dirty).toBe(baseline + 1);

    // 破坏二：删掉工作区里的文件
    const victim = wsPath(sandbox, 'docs/readme.md');
    await rm(victim, { force: true });
    expect(existsSync(victim)).toBe(false);

    await sandbox.reset();

    // 服务器回到了基线：多出来的 changelist 消失了。
    // 这一条同时是"强杀后残留 journal 没有被重放"的哨兵 —— journal 位于 root 之外，
    // 不会被模板复制覆盖，若残留下来 p4d 会把那次额外提交重放回来。
    expect(await latestChangeNumber(sandbox)).toBe(baseline);
    // 工作区也恢复了：文件回来了、内容回到基线、没有遗留的打开状态
    expect(existsSync(victim)).toBe(true);
    expect(await readWsFile(sandbox, 'src/util.txt')).toBe('util v2\n');
    expect(await sandbox.p4.records(['opened'])).toHaveLength(0);
  });
});
