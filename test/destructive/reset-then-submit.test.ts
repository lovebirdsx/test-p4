/**
 * reset 之后数据库仍然是健康的：能正常打开、提交、并被服务端记录。
 *
 * 这里的 reset 是**被测对象的一部分**，不能因为"新实例本来就是干净的"而省掉 ——
 * 它验的正是重置路径本身有没有把数据库弄坏（强制结束 p4d、丢弃 journal 之后
 * 能否重新拉起一个可写的库）。
 */
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { submitAll, writeWsFile } from '../helpers.ts';

describe('reset：重置后仍可提交', () => {
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
});
