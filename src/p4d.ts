/**
 * p4d 服务端的生命周期管理。
 *
 * 关键约束：**绝不允许裸启动 p4d**。不带 `-r` / `-p` 运行 p4d 会在当前目录建库并占用
 * 默认 1666 端口，可能污染机器状态。本模块永远显式传入二者，且把实例数据关在
 * 工程目录内。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { P4Cli } from './exec.ts';
import type { P4Record } from './parse.ts';
import { DEFAULT_CLIENT, EMPTY_DB_DIR, resolveP4dExe, type InstancePaths } from './paths.ts';
import { timed } from './timing.ts';

/**
 * 把全新的 root 初始化成 Unicode 模式。
 *
 * 必须做这一步：沙箱固定用 `P4CHARSET=utf8`（与注册表里的全局值一致），而
 * **非 Unicode 的 p4d 会直接拒绝 Unicode 客户端**（报
 * "Unicode clients require a unicode enabled server."），连 `p4 info` 都跑不通。
 * 实测 `p4d -r <空目录> -xi` 可直接初始化并输出 "Server switched to Unicode mode."
 */
function initUnicodeServer(exe: string, root: string): void {
  const result = spawnSync(exe, ['-r', root, '-xi'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(
      [
        `初始化 Unicode 服务器失败（p4d -xi 退出码 ${result.status}）`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

/** 从"空 Unicode 库"骨架快照恢复；快照缺失或不完整时返回 false，由调用方现场初始化 */
async function copyEmptyDb(root: string): Promise<boolean> {
  // db.domain 是 p4d 初始化后必有的标志文件，用它判断快照是否可用
  if (!existsSync(path.join(EMPTY_DB_DIR, 'db.domain'))) return false;
  await cp(EMPTY_DB_DIR, root, { recursive: true });
  return true;
}

/** 存一份"空 Unicode 库"骨架，供后续全新实例直接复制 */
async function snapshotEmptyDb(root: string): Promise<void> {
  try {
    await rmrf(EMPTY_DB_DIR);
    await cp(root, EMPTY_DB_DIR, { recursive: true });
  } catch {
    // 存快照失败不影响正确性 —— 下次仍会现场初始化
  }
}

/** 端口是否可用 */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** 优先使用 preferred；不可用则请操作系统分配一个空闲端口 */
export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred !== undefined && (await isPortFree(preferred))) return preferred;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询等待进程退出；返回它是否已经退出 */
async function waitForExit(pid: number, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

/**
 * Windows 上 p4d 退出后文件锁可能延迟释放，删除操作一律带重试，
 * 否则紧接着的复制/重建会莫名其妙失败。
 */
export async function rmrf(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

/** 强制结束进程；Windows 上用 taskkill 更彻底（能一并结束子进程） */
function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程可能刚好自行退出
  }
}

/** 读取日志尾部，用于启动失败时的诊断 */
async function tailLog(file: string, lines = 40): Promise<string> {
  try {
    const content = await readFile(file, 'utf8');
    const all = content.split(/\r?\n/);
    return all.slice(-lines).join('\n').trim();
  } catch {
    return '(无日志)';
  }
}

export interface StartP4dOptions {
  readonly inst: InstancePaths;
  /** 期望端口；被占用或未指定时自动分配 */
  readonly port?: number;
  /**
   * 若实例的 root 不存在，则从该模板目录复制一份作为起点
   * （`.sandbox/template`，由 `pnpm sandbox:snapshot` 生成）。
   */
  readonly templateDir?: string;
  /** 就绪等待上限 */
  readonly readyTimeoutMs?: number;
}

export class P4dServer {
  readonly inst: InstancePaths;
  readonly port: number;
  readonly exe: string;
  readonly p4: P4Cli;

  #child: ChildProcess | undefined;
  #lastInfo: P4Record | undefined;

  private constructor(inst: InstancePaths, port: number) {
    this.inst = inst;
    this.port = port;
    this.exe = resolveP4dExe();
    this.p4 = new P4Cli({ port, user: 'sandbox', client: DEFAULT_CLIENT }, inst);
  }

  /** 启动一个 p4d 实例并等待其就绪 */
  static async start(options: StartP4dOptions): Promise<P4dServer> {
    const { inst } = options;
    const port = await findFreePort(options.port);
    const server = new P4dServer(inst, port);
    await server.#prepareRoot(options.templateDir);
    await server.#launch();
    await server.waitReady(options.readyTimeoutMs ?? 60_000);
    return server;
  }

  /** 从已有的实例目录接管（不启动新进程），用于 `sandbox:status` / `sandbox:down` */
  static attach(inst: InstancePaths, port: number): P4dServer {
    return new P4dServer(inst, port);
  }

  async #prepareRoot(templateDir?: string): Promise<void> {
    await mkdir(this.inst.baseDir, { recursive: true });
    // 清掉上一次运行遗留的 pid 文件，避免读到过期 pid
    await rm(this.inst.pidFile, { force: true });

    // 已有可用数据库（db.domain 是 p4d 初始化后必有的标志文件）
    if (existsSync(path.join(this.inst.root, 'db.domain'))) return;

    // 优先从模板恢复：模板本身已是 Unicode 数据库
    if (templateDir && existsSync(templateDir)) {
      await rmrf(this.inst.root);
      await cp(templateDir, this.inst.root, { recursive: true });
      return;
    }

    // 全新实例：需要一份"已开 Unicode 模式"的空库。优先复制骨架快照（约 30ms），
    // 没有快照时才现场跑 `p4d -xi`（约 250ms），并顺手存一份给后续实例用。
    // 这段在 `reset({hard:true})` 的关键路径上，省下的是实打实的墙钟。
    await rmrf(this.inst.root);
    if (await copyEmptyDb(this.inst.root)) return;
    await mkdir(this.inst.root, { recursive: true });
    initUnicodeServer(this.exe, this.inst.root);
    await snapshotEmptyDb(this.inst.root);
  }

  async #launch(): Promise<void> {
    const args = [
      '-r', this.inst.root,
      '-p', `127.0.0.1:${this.port}`,
      '-J', this.inst.journal,
      '-L', this.inst.log,
      '-q',
      `--pid-file=${this.inst.pidFile}`,
    ];

    const child = spawn(this.exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    this.#child = child;
  }

  /** 轮询直到服务器能响应 `p4 info`；失败时附带日志尾部抛出 */
  async waitReady(timeoutMs = 60_000): Promise<void> {
    // 注意：这一段时间是上层 `p4d-start` 的子集，不是并列项
    await timed('wait-ready', () => this.#waitReady(timeoutMs));
  }

  async #waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let interval = 100;

    while (Date.now() < deadline) {
      if (this.#child && this.#child.exitCode !== null) {
        const log = await tailLog(this.inst.log);
        throw new Error(
          `p4d 进程已退出（退出码 ${this.#child.exitCode}），无法就绪。\n日志尾部：\n${log}`,
        );
      }
      try {
        // 刻意不加 `-q`：它会把 `p4 info` 的输出一起抑制掉，而这里要把记录留下来
        // 给隔离自检复用（见 lastInfo），从而省掉启动流程里的另一次 p4 往返。
        const result = await this.p4.run(['info'], { format: 'ztag', timeoutMs: 5_000 });
        this.#lastInfo = result.records[0];
        return;
      } catch {
        await delay(interval);
        interval = Math.min(interval * 1.5, 500);
      }
    }

    const log = await tailLog(this.inst.log);
    throw new Error(
      `等待 p4d 就绪超时（${timeoutMs}ms，端口 ${this.port}）。\n日志尾部：\n${log}`,
    );
  }

  /**
   * 就绪探测时抓到的 `p4 info` 记录。
   *
   * 供 `Sandbox.assertIsolated()` 复用，省掉启动流程里的一次 p4 往返。
   * 缓存的生命周期就是这个 server 实例：`Sandbox.reset()` 会换一个新的 `P4dServer`，
   * 缓存天然失效；而 `P4dServer.attach()` 从未跑过探测，`lastInfo` 为 undefined，
   * 自检会退回现查 —— 所以判据本身不受影响。
   */
  get lastInfo(): P4Record | undefined {
    return this.#lastInfo;
  }

  /** pid 文件里记录的进程号（可能已被系统复用，仅用于停止流程） */
  async readPid(): Promise<number | undefined> {
    try {
      const raw = (await readFile(this.inst.pidFile, 'utf8')).trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** 服务器是否仍在响应 */
  async isRunning(): Promise<boolean> {
    try {
      await this.p4.run(['info'], { format: 'text', quiet: true, timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 停止服务器。
   *
   * 默认走 `p4 admin stop` 让 p4d 干净收尾（把 journal 落回数据库）。实测 p4d
   * 收尾本身要花约 950ms —— 这是 reset 路径上**最大的一笔开销**（占一次 reset 的 70%），
   * 远超"少起几次 p4 子进程"能省下的量。所以只有数据要保留的调用方
   * （`ensureTemplate` 的快照、`sandbox:down`）才用默认路径。
   *
   * `force: true` 直接强杀：调用方必须保证紧接着就销毁或覆盖数据库
   * （`reset` / `dispose`），那份干净 journal 没有任何保留价值。
   */
  async stop(options: { force?: boolean } = {}): Promise<void> {
    const pid = await this.readPid();
    if (pid === undefined) return;

    if (!options.force) {
      // 先请求服务器自行干净退出；失败也无妨，下面还有强杀兜底
      await this.p4.run(['admin', 'stop'], {
        format: 'text',
        quiet: true,
        allowFailure: true,
        timeoutMs: 10_000,
      });
      if (await waitForExit(pid, 20_000, 50)) return;
    }

    forceKill(pid);
    await waitForExit(pid, 5_000, 25);
  }

  /** 实例状态快照，供状态文件与日志使用 */
  snapshot(): Record<string, unknown> {
    return {
      name: this.inst.name,
      port: this.port,
      root: this.inst.root,
      wsRoot: this.inst.wsRoot,
      pidFile: this.inst.pidFile,
      log: this.inst.log,
      exe: this.exe,
    };
  }
}

/** 清理实例目录（用于重置/回收） */
export async function removeInstance(inst: InstancePaths): Promise<void> {
  await rmrf(inst.root);
  await rmrf(inst.journal);
  await rmrf(inst.log);
  await rmrf(inst.pidFile);
  await rmrf(inst.tickets);
  await rmrf(inst.enviro);
  await rmrf(inst.trust);
  await rmrf(inst.wsRoot);
}

/** 把当前实例的 root 存为模板（必须在 p4d 已停止时调用） */
export async function snapshotToTemplate(inst: InstancePaths, templateDir: string): Promise<void> {
  await rmrf(templateDir);
  await mkdir(templateDir, { recursive: true });
  await cp(inst.root, templateDir, { recursive: true });
}

/**
 * 扫描僵尸实例：pid 文件存在但进程已不存活。
 * 返回仍存活的实例名，便于上层决定是否清理。
 */
export async function zombieCheck(instancesDir: string): Promise<string[]> {
  if (!existsSync(instancesDir)) return [];
  const alive: string[] = [];
  for (const entry of await readdir(instancesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pidFile = path.join(instancesDir, entry.name, 'server.pid');
    try {
      const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
      if (Number.isFinite(pid) && isProcessAlive(pid)) alive.push(entry.name);
    } catch {
      // 无 pid 文件：该实例已不在运行
    }
  }
  return alive;
}
