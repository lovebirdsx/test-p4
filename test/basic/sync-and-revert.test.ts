import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { latestChangeNumber, readWsFile, submitAll, wsPath, writeWsFile } from '../helpers.ts';

describe('sync 与 revert', () => {
  test('revert 把被修改的文件恢复原状', async ({ sandbox }) => {
    const original = await readWsFile(sandbox, 'src/util.txt');

    await sandbox.p4.run(['edit', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await writeWsFile(sandbox, 'src/util.txt', '临时改动，稍后要被丢弃\n');

    expect(await sandbox.p4.records(['opened'])).toHaveLength(1);

    await sandbox.p4.run(['revert', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    expect(await sandbox.p4.records(['opened'])).toHaveLength(0);
    expect(await readWsFile(sandbox, 'src/util.txt')).toBe(original);
  });

  test('sync -f 能修复被本地删除的文件', async ({ sandbox }) => {
    const target = wsPath(sandbox, 'docs/readme.md');
    await rm(target, { force: true });
    expect(existsSync(target)).toBe(false);

    await sandbox.p4.run(['sync', '-f', '//depot/main/docs/readme.md'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    expect(existsSync(target)).toBe(true);
  });

  test('按 revision 同步可以取回历史版本内容', async ({ sandbox }) => {
    // 先提交一次修改，让 util.txt 产生 rev3
    await sandbox.p4.run(['edit', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await writeWsFile(sandbox, 'src/util.txt', 'util v3\n');
    const change = await submitAll(sandbox, '用例：产生 rev3');

    const fstatAfter = await sandbox.p4.records(['fstat', '//depot/main/src/util.txt']);
    expect(fstatAfter[0]?.headRev).toBe('3');

    // 同步回 rev2
    await sandbox.p4.run(['sync', '//depot/main/src/util.txt#2'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    expect(await readWsFile(sandbox, 'src/util.txt')).toBe('util v2\n');

    const fstatRollback = await sandbox.p4.records(['fstat', '//depot/main/src/util.txt']);
    expect(fstatRollback[0]?.haveRev).toBe('2');
    expect(fstatRollback[0]?.headRev).toBe('3');

    // 再同步回最新，内容恢复
    await sandbox.p4.run(['sync', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    expect(await readWsFile(sandbox, 'src/util.txt')).toBe('util v3\n');
    expect(change).toBeGreaterThan(0);
  });

  test('sync -n 只预演不落盘', async ({ sandbox }) => {
    const before = await latestChangeNumber(sandbox);
    const target = wsPath(sandbox, 'docs/readme.md');
    await rm(target, { force: true });

    // 需要 -f：本地文件被删并不会改变 have rev，普通预演会认为"无事可做"而不报告
    const preview = await sandbox.p4.run(['sync', '-n', '-f', '//depot/main/docs/readme.md'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    // 预演报告了要更新的内容，但文件并没有被写回
    expect(preview.stdout).toMatch(/readme\.md/);
    expect(existsSync(target)).toBe(false);
    expect(before).toBe(await latestChangeNumber(sandbox));
  });
});
