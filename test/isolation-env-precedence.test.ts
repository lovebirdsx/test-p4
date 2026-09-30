/**
 * 隔离防护：环境变量能否压过机器级配置。
 *
 * 这条用例单独占一个文件，且**不用沙箱夹具** —— 它只需要一份构造好的环境，
 * 不需要真的起一个服务器。这么做有两个原因：它本身有约 2s 的固有开销（见下），
 * 单独成文件才能与其它文件并行；同时也不必付夹具那约 0.5s 的实例启动成本。
 *
 * 关于那 2 秒：连一个**关闭的**端口时，p4 客户端内部会自行重试，实测约 2.05s 才
 * 放弃（OS 层其实是立即 ECONNREFUSED，Node 实测 0-1ms）。这个数字调不小 ——
 * `p4 help environment` 里没有任何超时或 net 相关变量，`net.*` 全是服务端
 * configurable，而本仓库禁止 `p4 set`（它会写注册表）。也不能改用"活着但不是 p4
 * 的监听端口"来制造失败：实测 p4 会一直等握手，>8s 不返回，比死端口更慢一个数量级。
 *
 * 结论：接受这 2s，本项目能做的只是把它挪出关键路径。
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CLIENT, DEFAULT_USER, buildP4Env, resolveP4Exe, tempInstancePaths } from '../src/index.ts';

describe('隔离防护：环境变量优先级', () => {
  test('进程环境变量压过注册表：指向关闭端口时连的就是该端口', () => {
    // 必须绕过 P4Cli 直连：参数层守卫会拒绝调用方自带 -p，这正是它该做的。
    // 顺带一提，这条能成立还依赖 P4CONFIG=noconfig —— 否则 .p4config 会压过环境变量。
    const inst = tempInstancePaths('isolation-env-probe');
    const env = {
      ...buildP4Env({ port: 9, user: DEFAULT_USER, client: DEFAULT_CLIENT }, inst),
      P4PORT: '127.0.0.1:9',
    };
    const result = spawnSync(resolveP4Exe(), ['info'], { env, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).not.toBe(0);
    // 连的正是我们指定的端口，而不是任何别处
    expect(output).toContain('127.0.0.1:9');
    // 输出里不该出现任何"主机名:端口"形态（回环 IP 不会被这个模式命中）
    expect(output).not.toMatch(/[\w-]+\.[a-z]{2,}:\d+/i);
  });
});
