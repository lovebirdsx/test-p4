import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe } from 'vitest';
import { expect, test } from '../fixtures.ts';
import { writeWsFile } from '../helpers.ts';

/** 副工作区只映射 //depot/main/src/... —— 用来验证部分映射与工作区隔离 */
const SRC_CLIENT = 'sandbox_src';

describe('client 工作区映射', () => {
  test('副工作区只映射 src 子目录，看不到 docs', async ({ sandbox }) => {
    const root = path.join(sandbox.inst.wsRoot, SRC_CLIENT);
    await mkdir(root, { recursive: true });

    await sandbox.p4.run(['sync'], { format: 'text', cwd: root, client: SRC_CLIENT });

    expect(existsSync(path.join(root, 'src', 'hello.txt'))).toBe(true);
    // docs 未在 View 中，不应出现在工作区
    expect(existsSync(path.join(root, 'docs'))).toBe(false);
  });

  test('未映射的路径在 where 里查不到', async ({ sandbox }) => {
    const mapped = await sandbox.p4.records(['where', '//depot/main/src/hello.txt'], {
      client: SRC_CLIENT,
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.path?.toLowerCase()).toContain('sandbox_src');

    // 未映射的路径：p4 where 只发 warning，**退出码仍然是 0**（它不是错误），
    // 所以这里用 -s 的严重级前缀来断言级别，比断言退出码更准确。
    const unmapped = await sandbox.p4.run(['where', '//depot/main/docs/readme.md'], {
      client: SRC_CLIENT,
      format: 'text',
      severity: true,
    });
    const output = `${unmapped.stdout}${unmapped.stderr}`;
    expect(output).toMatch(/warning: .*not in client view/i);
    expect(output).not.toMatch(/info: /);
  });

  test('两个工作区的 have list 互相独立', async ({ sandbox }) => {
    const root = path.join(sandbox.inst.wsRoot, SRC_CLIENT);
    await mkdir(root, { recursive: true });
    await sandbox.p4.run(['sync'], { format: 'text', cwd: root, client: SRC_CLIENT });

    // 副工作区同步后，它有自己的 have 记录
    const srcHave = await sandbox.p4.run(['have'], {
      format: 'text',
      cwd: root,
      client: SRC_CLIENT,
    });
    expect(srcHave.stdout).toMatch(/hello\.txt/);

    // 在主工作区里修改并提交，不影响副工作区的 have rev
    await sandbox.p4.run(['edit', '//depot/main/src/hello.txt'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });
    await writeWsFile(sandbox, 'src/hello.txt', '主工作区的改动\n');
    await sandbox.p4.run(['submit', '-d', '用例：主工作区提交'], {
      format: 'text',
      cwd: sandbox.clientRoot,
    });

    const srcFstat = await sandbox.p4.records(['fstat', '//depot/main/src/hello.txt'], {
      client: SRC_CLIENT,
      cwd: root,
    });
    expect(srcFstat[0]?.haveRev).toBe('2'); // 仍是旧版本
    expect(srcFstat[0]?.headRev).toBe('3'); // 服务器已前进

    const mainFstat = await sandbox.p4.records(['fstat', '//depot/main/src/hello.txt']);
    expect(mainFstat[0]?.haveRev).toBe('3');
  });
});
