import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { latestChangeNumber, readWsFile, submitAll, wsPath, writeWsFile } from '../helpers.ts';

describe('破坏性实验与快速重置', () => {
  test('提交额外 changelist + 删文件后，reset 回到基线', async ({ sandbox }) => {
    // 本文件的用例都会改动实例状态，因此每个用例都从干净基线起步
    await sandbox.reset();
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

    // 服务器回到了基线：多出来的 changelist 消失了
    expect(await latestChangeNumber(sandbox)).toBe(baseline);
    // 工作区也恢复了：文件回来了、内容回到基线、没有遗留的打开状态
    expect(existsSync(victim)).toBe(true);
    expect(await readWsFile(sandbox, 'src/util.txt')).toBe('util v2\n');
    expect(await sandbox.p4.records(['opened'])).toHaveLength(0);
  });

  test('reset 是幂等的：连续两次结果一致', async ({ sandbox }) => {
    await sandbox.reset();
    const first = await latestChangeNumber(sandbox);
    const firstFiles = (await sandbox.p4.records(['files', '//depot/main/...'])).length;

    await sandbox.reset();
    expect(await latestChangeNumber(sandbox)).toBe(first);
    expect((await sandbox.p4.records(['files', '//depot/main/...'])).length).toBe(firstFiles);
  });

  test('reset 之后仍可正常提交（数据库是健康的）', async ({ sandbox }) => {
    await sandbox.reset();

    await sandbox.p4.run(['edit', '//depot/main/src/hello.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await writeWsFile(sandbox, 'src/hello.txt', '重置之后的新内容\n');
    const change = await submitAll(sandbox, '重置后的提交');

    expect(change).toBeGreaterThan(0);
    const fstat = await sandbox.p4.records(['fstat', '//depot/main/src/hello.txt']);
    expect(fstat[0]?.headAction).toBe('edit');
  });

  test('reset --hard 会重新 seed 出一份基线', async ({ sandbox }) => {
    await sandbox.reset();
    const baseline = await latestChangeNumber(sandbox);

    await sandbox.p4.run(['delete', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await submitAll(sandbox, '破坏性实验：删除文件');

    await sandbox.reset({ hard: true });

    expect(await latestChangeNumber(sandbox)).toBe(baseline);
    expect(await readWsFile(sandbox, 'src/util.txt')).toBe('util v2\n');
  });
});
