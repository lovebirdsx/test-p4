/**
 * `reset({ hard: true })` 会丢弃模板、重新 seed 出一份基线。
 *
 * 这是最贵的一条 reset 路径（要跑完整 seed），所以它单独占一个文件 ——
 * 否则它会拖住同文件里那几条便宜用例。
 */
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { latestChangeNumber, readWsFile, submitAll } from '../helpers.ts';

describe('reset：--hard 重新 seed', () => {
  test('reset --hard 会重新 seed 出一份基线', async ({ sandbox }) => {
    const baseline = await latestChangeNumber(sandbox);

    await sandbox.p4.run(['delete', '//depot/main/src/util.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await submitAll(sandbox, '破坏性实验：删除文件');

    await sandbox.reset({ hard: true });

    // 重新 seed 是确定性的：changelist 号与模板基线一致
    expect(await latestChangeNumber(sandbox)).toBe(baseline);
    expect(await readWsFile(sandbox, 'src/util.txt')).toBe('util v2\n');
  });
});
