import path from 'node:path';
import { describe } from 'vitest';
import { PROJECT_ROOT } from '../../src/index.ts';
import { expect, test } from '../fixtures.ts';
import { latestChangeNumber, readWsFile } from '../helpers.ts';

const TOOL = path.join(PROJECT_ROOT, 'examples', 'under-test', 'mark-tool.ts');

describe('被测工具接入沙箱', () => {
  test('工具零改动地通过沙箱注入的环境操作 Perforce', async ({ sandbox }) => {
    const before = await latestChangeNumber(sandbox);

    // 往进程环境里塞一个脏的 P4PORT（模拟机器级全局配置）：
    // 它绝不能传导给被测工具 —— 工具只认沙箱注入的那一份
    const saved = process.env;
    process.env = { ...process.env, P4PORT: 'p4.example.invalid:1666' };
    const result = await sandbox
      .handle()
      .run(process.execPath, [TOOL, 'src/util.txt', '来自工具的标记'])
      .finally(() => {
        process.env = saved;
      });

    expect(result.exitCode).toBe(0);
    // 工具自己打印出的 P4PORT 就是沙箱端口 —— 证明环境注入生效
    expect(result.stdout).toContain(`P4PORT=127.0.0.1:${sandbox.port}`);
    // 脏值没有漏出去：工具看到的每一个"主机:端口"都是沙箱地址
    const targets = result.stdout.match(/[\w.-]+:\d+/g) ?? [];
    expect(targets.filter((t) => t !== `127.0.0.1:${sandbox.port}`)).toEqual([]);

    // 它确实改动了沙箱里的数据
    expect(await latestChangeNumber(sandbox)).toBe(before + 1);
    expect(await readWsFile(sandbox, 'src/util.txt')).toContain('来自工具的标记');
  });

  test('句柄可以指定别的工作区，env() 可直接交给任意子进程', async ({ sandbox }) => {
    const handle = sandbox.handle('sandbox_src');
    const env = handle.env();

    expect(env.P4PORT).toBe(`127.0.0.1:${sandbox.port}`);
    expect(env.P4CLIENT).toBe('sandbox_src');
    expect(env.P4USER).toBe('sandbox');
    // 路径指向本实例的工作区
    expect(handle.clientRoot.toLowerCase()).toContain('sandbox_src');
  });
});
