/**
 * 隔离防护的验证 —— 本工程最重要的一组回归。
 *
 * 本机的全局 Perforce 配置可能指向一台真实的服务器，因此这里既要验证"正常路径连的是沙箱"，
 * 也要验证"即使有人把环境搞脏，也连不到别处"。
 *
 * 这组用例刻意**不含任何具体的服务器地址**：防护的判据是"位置"与"结构"，
 * 断言也应该是对应的规则，而不是"输出里没有某个字符串"。
 */
import path from 'node:path';
import { describe } from 'vitest';
import { assertSandboxOwnsGlobalOptions, buildP4Env, field, Sandbox } from '../src/index.ts';
import { expect, test } from './fixtures.ts';

describe('隔离防护', () => {
  test('连的是本实例的服务器 root', async ({ sandbox }) => {
    const records = await sandbox.p4.records(['info']);
    const serverRoot = (field(records[0] ?? {}, 'serverRoot') ?? '').toLowerCase();

    expect(serverRoot).toContain('.sandbox');
    expect(serverRoot).toContain(sandbox.inst.name.toLowerCase());
  });

  test('调用方自带全局选项一律被拒绝', async ({ sandbox }) => {
    // 沙箱已在参数最前面注入了自己的 -p/-u/-c。调用方再传全局选项只会与注入的争抢，
    // 造成覆盖或歧义。判据是**位置**（命令名之前）而不是值，所以下面这些形态全都拦得住 ——
    // 包括那些根本看不出地址的（-u / -x）。
    const attempts: readonly (readonly string[])[] = [
      ['-p', 'p4.example.invalid:1666', 'info'],
      ['--port=p4.example.invalid:1666', 'info'],
      ['-p', '127.0.0.1:1666', 'info'], // 就算是回环地址也一样拒绝：端口由沙箱统一管理
      ['-u', 'someone-else', 'info'],
      ['-x', 'args.txt', 'info'], // 从文件读参数 —— 文件内容由调用方决定
    ];

    for (const args of attempts) {
      await expect(sandbox.p4.run(args), args.join(' ')).rejects.toThrow(/全局选项/);
    }
  });

  test('构造出的环境只含沙箱自己的 P4 变量', async ({ sandbox }) => {
    // 先往进程环境里塞一批"脏值"，模拟机器级全局配置与 shell 残留
    const dirty: NodeJS.ProcessEnv = {
      P4PORT: 'p4.example.invalid:1666',
      P4USER: 'not-sandbox',
      P4CLIENT: 'not-sandbox',
      P4TRUST: 'C:\\Users\\someone\\p4trust.txt',
      P4PASSWD: 'not-a-real-password',
    };
    const saved = process.env;
    process.env = { ...process.env, ...dirty };
    try {
      const env = buildP4Env(sandbox.identity, sandbox.inst);

      // 沙箱值胜出
      expect(env.P4PORT).toBe(`127.0.0.1:${sandbox.port}`);
      expect(env.P4USER).toBe(sandbox.identity.user);
      expect(env.P4CONFIG).toBe('noconfig');
      expect(env.P4CHARSET).toBe('utf8');

      // 票据 / 配置源 / 信任文件都必须落在本实例目录里，不碰用户的全局状态
      for (const key of ['P4TICKETS', 'P4ENVIRO', 'P4TRUST'] as const) {
        expect(env[key], `${key} 应指向本实例目录`).toContain(sandbox.inst.baseDir);
      }

      // 关键：除白名单外不允许残留任何 P4* 键。
      // 将来 p4 新增任何变量、或 buildP4Env 漏清某个，这里都会立刻失败 ——
      // 这比"断言不含某个已知字符串"强得多。
      const allowed = new Set([
        'P4PORT',
        'P4USER',
        'P4CLIENT',
        'P4CONFIG',
        'P4IGNORE',
        'P4EDITOR',
        'P4MERGE',
        'P4DIFF',
        'P4TICKETS',
        'P4ENVIRO',
        'P4TRUST',
        'P4CHARSET',
      ]);
      const leaked = Object.keys(env).filter(
        (key) => /^P4/i.test(key) && !allowed.has(key.toUpperCase()),
      );
      expect(leaked).toEqual([]);

      // p4 会用 $PWD 判断"当前目录"，它必须已被删掉（否则会盖过子进程真实 cwd）
      expect(env.PWD).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  // 「进程环境变量压过注册表：指向关闭端口时连的就是该端口」已挪到
  // `isolation-env-precedence.test.ts`：那条用例有约 2s 的固有开销（连死端口时 p4
  // 客户端内部会重试），单独成文件才能与其它文件并行，也不再需要沙箱夹具。

  test('自检复用的就绪探测记录确实指向本实例', async ({ sandbox }) => {
    // 就绪探测会把 `p4 info` 的记录留在 server 上，自检直接复用它（省一次 p4 往返）。
    // 这条用例确认缓存真的被填上了、且内容就是本实例的 root —— 否则"省掉一次查询"
    // 就会悄悄变成"跳过了一次校验"。
    const cached = sandbox.server.lastInfo;
    expect(cached).toBeDefined();

    const normalize = (value: string) => path.resolve(value).toLowerCase();
    expect(normalize(field(cached ?? {}, 'serverRoot') ?? '')).toBe(
      normalize(sandbox.inst.root),
    );
  });

  test('自检会在服务器 root 不匹配时抛错', async ({ sandbox }) => {
    // 拿另一个 root 去"自检"，必须失败 —— 证明 assertIsolated 真的在比对
    const fake = {
      ...sandbox.inst,
      root: `${sandbox.inst.root}-not-this-one`,
    };
    const attached = Sandbox.attach(fake, sandbox.port);

    await expect(attached.assertIsolated()).rejects.toThrow(/不是本实例/);
  });

  test('参数层守卫放行正常命令，拒绝以选项开头的参数', () => {
    // 直接调用守卫，覆盖 p4 之外的调用路径（比如将来接入别的封装）
    expect(() => assertSandboxOwnsGlobalOptions(['sync', '//depot/main/...'])).not.toThrow();
    expect(() => assertSandboxOwnsGlobalOptions(['changes', '-m', '5'])).not.toThrow();
    expect(() => assertSandboxOwnsGlobalOptions([])).not.toThrow();

    expect(() => assertSandboxOwnsGlobalOptions(['-p', 'x:1', 'info'])).toThrow(/全局选项/);
    expect(() => assertSandboxOwnsGlobalOptions(['--port=x:1', 'info'])).toThrow(/全局选项/);
  });
});
