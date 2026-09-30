/**
 * reset 的可重复性：既复现基线，也经得起连着做两次。
 *
 * 用「全新实例的状态」当对照，比原来的"reset 两次互相比"更强 —— 它直接断言
 * reset 复现的是**模板基线**本身，而不只是"两次结果碰巧一致"。
 */
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { latestChangeNumber } from '../helpers.ts';

describe('reset：幂等性', () => {
  test('reset 复现基线，且重复 reset 结果稳定', async ({ sandbox }) => {
    // 新实例本身就是模板基线，直接拿它当"第一次观测"，省掉一次 reset
    const baseline = await latestChangeNumber(sandbox);
    const baselineFiles = (await sandbox.p4.records(['files', '//depot/main/...'])).length;

    await sandbox.reset();
    expect(await latestChangeNumber(sandbox)).toBe(baseline);
    expect((await sandbox.p4.records(['files', '//depot/main/...'])).length).toBe(baselineFiles);

    // 再来一次。第二次是必要的：残留 journal、数据库没落盘之类的毛病往往只在
    // 第二次 reset 才暴露（journal 在 root 之外，不受模板复制影响）。
    await sandbox.reset();
    expect(await latestChangeNumber(sandbox)).toBe(baseline);
    expect((await sandbox.p4.records(['files', '//depot/main/...'])).length).toBe(baselineFiles);
  });
});
