import { describe } from 'vitest';
import type { Sandbox } from '../../src/index.ts';
import { expect, test } from '../fixtures.ts';
import { expectP4Failure, latestChangeNumber, submitAll, writeWsFile } from '../helpers.ts';

describe('changelist 生命周期', () => {
  test('默认 changelist：edit → 改文件 → submit', async ({ sandbox }) => {
    const before = await latestChangeNumber(sandbox);

    // sync 下来的文件是只读的，必须先 p4 edit 打开
    await sandbox.p4.run(['edit', '//depot/main/src/hello.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    const opened = await sandbox.p4.records(['opened']);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.depotFile).toBe('//depot/main/src/hello.txt');
    expect(opened[0]?.change).toBe('default');

    await writeWsFile(sandbox, 'src/hello.txt', '被用例修改过的内容\n');
    const after = await submitAll(sandbox, '用例：修改 hello');

    expect(after).toBe(before + 1);
    expect(await sandbox.p4.records(['opened'])).toHaveLength(0);

    const fstat = await sandbox.p4.records(['fstat', '//depot/main/src/hello.txt']);
    expect(fstat[0]?.headRev).toBe('3'); // 基线是 rev2，本次提交成 rev3
    expect(fstat[0]?.headAction).toBe('edit');
  });

  test('命名 changelist：创建 → 挂文件 → 提交', async ({ sandbox }) => {
    const changeNumber = await createPendingChange(sandbox, '用例：命名 changelist');
    const before = await latestChangeNumber(sandbox);

    await sandbox.p4.run(['edit', '-c', changeNumber, '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    const opened = await sandbox.p4.records(['opened']);
    expect(opened[0]?.change).toBe(changeNumber);

    await writeWsFile(sandbox, 'src/util.txt', 'util v3（命名 changelist 提交）\n');
    // 注意：`submit -c` 与 `-d` 互斥（描述在创建 changelist 时就已写好）
    await sandbox.p4.run(['submit', '-c', changeNumber], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    // 该 changelist 已转入已提交状态，且编号大于此前的最新号
    const submitted = await sandbox.p4.records(['changes', '-m', '1', '-s', 'submitted']);
    const newNumber = Number.parseInt(submitted[0]?.change ?? '0', 10);
    expect(newNumber).toBeGreaterThan(before);
    expect(newNumber).toBe(Number.parseInt(changeNumber, 10));

    // pending 列表里不再有它
    const pending = await sandbox.p4.records(['changes', '-s', 'pending']);
    expect(pending.map((r) => r.change)).not.toContain(changeNumber);
  });

  test('删除并提交：headAction 变成 delete', async ({ sandbox }) => {
    await sandbox.p4.run(['delete', '//depot/main/docs/readme.md'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await submitAll(sandbox, '用例：删除 readme');

    const fstat = await sandbox.p4.records(['fstat', '//depot/main/docs/readme.md']);
    expect(fstat[0]?.headAction).toBe('delete');
  });

  test('提交空的 changelist 会失败', async ({ sandbox }) => {
    const changeNumber = await createPendingChange(sandbox, '用例：空 changelist');

    await expectP4Failure(
      () =>
        sandbox.p4.run(['submit', '-c', changeNumber], {
          format: 'text',
          cwd: sandbox.clientRoot,
        }),
      /no files to submit|No files to submit/i,
    );

    // 失败后 changelist 仍处于 pending
    const pending = await sandbox.p4.records(['changes', '-s', 'pending']);
    expect(pending.map((r) => r.change)).toContain(changeNumber);
  });
});

/** 创建一个 pending changelist 并返回其编号 */
async function createPendingChange(sandbox: Sandbox, description: string): Promise<string> {
  const form = [
    'Change:\tnew',
    '',
    'Client:\tsandbox_main',
    '',
    'User:\tsandbox',
    '',
    'Status:\tnew',
    '',
    'Description:',
    `\t${description}`,
    '',
  ].join('\n');

  await sandbox.p4.run(['change', '-i'], { input: form, format: 'text' });

  const pending = await sandbox.p4.records(['changes', '-s', 'pending', '-m', '1']);
  const change = pending[0]?.change;
  if (!change) throw new Error('未能创建 pending changelist');
  return change;
}
