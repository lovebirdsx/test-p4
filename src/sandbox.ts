/**
 * 沙箱门面：把 p4d 生命周期、p4 客户端、种子夹具、重置能力合成一个对象，
 * 并对外给出"被测工具接入句柄"。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildP4Env, type P4Identity } from './env.ts';
import { P4Cli, type P4Result, type RunP4Options } from './exec.ts';
import { field, getFormField, setFormField, type P4Record } from './parse.ts';
import { P4dServer, removeInstance, rmrf, snapshotToTemplate } from './p4d.ts';
import {
  DEFAULT_CLIENT,
  DEFAULT_PORT,
  DEFAULT_USER,
  PROJECT_ROOT,
  TEMPLATE_DIR,
  SANDBOX_DIR,
  residentPaths,
  tempInstancePaths,
  type InstancePaths,
} from './paths.ts';
import { seedSandbox, type SeedOptions } from './seed.ts';

/** 运行时数据根（`.sandbox/instances/`） */
export const INSTANCES_DIR = path.join(SANDBOX_DIR, 'instances');

const TEMPLATE_INSTANCE_NAME = '__template__';

/**
 * 保证模板存在：模板是所有实例的"干净基线"，缺失时用一个临时实例 seed 一份。
 * 这是唯一会跑完整 seed 的地方，因此把它放在 vitest 的 globalSetup 里只跑一次。
 */
export async function ensureTemplate(seedOptions: SeedOptions = {}): Promise<void> {
  if (existsSync(TEMPLATE_DIR)) return;

  const inst = tempInstancePaths(TEMPLATE_INSTANCE_NAME);
  await removeInstance(inst);

  const server = await P4dServer.start({ inst });
  try {
    await seedSandbox(server.p4, inst, seedOptions);
  } finally {
    await server.stop();
  }

  await snapshotToTemplate(inst, TEMPLATE_DIR);
  await removeInstance(inst);
  await rmrf(inst.baseDir);
}

export interface SandboxStartOptions {
  /** 测试实例名；常驻沙箱忽略此项 */
  readonly name?: string;
  /** true = 常驻沙箱（固定端口、目录在 .sandbox 根下，便于 P4V 连接） */
  readonly resident?: boolean;
  /** 期望端口；被占用或未指定时自动分配 */
  readonly port?: number;
  /** 首次 seed 用的夹具选项（仅在生成模板时生效） */
  readonly seedOptions?: SeedOptions;
  /** 启动后是否把工作区同步到基线（默认 true；纯服务器端用例可关掉以加快启动） */
  readonly syncWorkspace?: boolean;
  /** 跳过"等待就绪后自检"（一般不要跳过） */
  readonly skipIsolationCheck?: boolean;
}

/** 被测工具接入句柄：把工具当成黑盒跑，由沙箱注入全部 p4 环境 */
export interface SandboxHandle {
  readonly port: number;
  readonly user: string;
  readonly client: string;
  /** 主工作区的绝对路径 */
  readonly clientRoot: string;
  /** 工作区根（各 client 都是它的子目录） */
  readonly wsRoot: string;
  /** 可直接传给子进程的干净环境 */
  env(): NodeJS.ProcessEnv;
  /** 在沙箱内执行 p4 */
  p4(args: readonly string[], options?: RunP4Options): Promise<P4Result>;
  /** 以沙箱环境运行任意外部工具（Node / Python / 二进制均可） */
  run(tool: string, args: readonly string[], options?: { cwd?: string }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export class Sandbox {
  readonly inst: InstancePaths;
  #server: P4dServer;
  #seedOptions: SeedOptions;
  #resident: boolean;

  private constructor(
    inst: InstancePaths,
    server: P4dServer,
    seedOptions: SeedOptions,
    resident: boolean,
  ) {
    this.inst = inst;
    this.#server = server;
    this.#seedOptions = seedOptions;
    this.#resident = resident;
  }

  static async start(options: SandboxStartOptions = {}): Promise<Sandbox> {
    const resident = options.resident ?? false;
    const inst = resident
      ? residentPaths()
      : tempInstancePaths(
          options.name ?? `t${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        );

    if (!existsSync(inst.root)) {
      await ensureTemplate(options.seedOptions ?? {});
    }

    // 常驻沙箱默认固定端口，方便 P4V 直接连；被占用时会自动改用空闲端口（见 CLI 输出）
    const port = options.port ?? (resident ? DEFAULT_PORT : undefined);
    const server = await P4dServer.start({
      inst,
      ...(port !== undefined ? { port } : {}),
      templateDir: TEMPLATE_DIR,
    });

    const sandbox = new Sandbox(inst, server, options.seedOptions ?? {}, resident);
    await sandbox.#prepareWorkspace(options.syncWorkspace ?? true);
    if (!options.skipIsolationCheck) {
      await sandbox.assertIsolated();
    }
    return sandbox;
  }

  /**
   * 模板里的 client spec 记录的是**模板实例**的绝对路径；复制到新实例后必须把 Root
   * 改回本实例的工作区目录，否则 p4 会把文件同步到早已被删除的模板目录里。
   */
  async #retargetClients(): Promise<void> {
    // 不要加 `-u <user>` 过滤：owner 字段在某些情况下为空会导致查不到任何工作区
    const records = await this.p4.records(['clients']);
    for (const record of records) {
      const name = field(record, 'client');
      if (!name) continue;
      const target = path.join(this.inst.wsRoot, name);
      const form = (await this.p4.run(['client', '-o', name], { format: 'text' })).stdout;
      const current = getFormField(form, 'Root');
      if (current && path.resolve(current) === path.resolve(target)) continue;
      await this.p4.run(['client', '-i'], {
        input: setFormField(form, 'Root', target),
        format: 'text',
      });
    }
  }

  /**
   * 让工作区真正有文件。
   * 注意必须用 `sync -f`：从模板复制来的 have list 声称文件已同步，普通 sync 会认为
   * 无事可做，而磁盘上其实什么都没有。
   */
  async #syncWorkspace(): Promise<void> {
    const root = path.join(this.inst.wsRoot, DEFAULT_CLIENT);
    await mkdir(root, { recursive: true });
    await this.p4.run(['sync', '-f', '//depot/main/...'], {
      format: 'text',
      cwd: root,
      client: DEFAULT_CLIENT,
    });
  }

  async #prepareWorkspace(sync: boolean): Promise<void> {
    await this.#retargetClients();
    if (sync) await this.#syncWorkspace();
  }

  /** 从已有实例接管（不启动新进程），供 `sandbox:down` / `sandbox:status` 使用 */
  static attach(inst: InstancePaths, port: number): Sandbox {
    const server = P4dServer.attach(inst, port);
    return new Sandbox(inst, server, {}, inst.baseDir === SANDBOX_DIR);
  }

  get port(): number {
    return this.#server.port;
  }

  get p4(): P4Cli {
    return this.#server.p4;
  }

  get server(): P4dServer {
    return this.#server;
  }

  get identity(): P4Identity {
    return { port: this.port, user: DEFAULT_USER, client: DEFAULT_CLIENT };
  }

  /** 主工作区路径 */
  get clientRoot(): string {
    return path.join(this.inst.wsRoot, DEFAULT_CLIENT);
  }

  /**
   * 隔离自检：确认当前连的确实是本实例的沙箱。
   * 任何一次沙箱启动都会执行；不通过就说明防护被绕过，必须立刻失败。
   *
   * 判据只有一条 —— 服务器**自己报出**的数据库目录必须等于本实例的 root。
   * 这是充分判据：连到任何别的服务器，这个路径都不可能相同。
   *
   * 为什么不看 `Server address`：p4d 会把它报成反向解析出来的主机名，未必含
   * `127.0.0.1`（实测如此），据此判断会误报。为什么不用"已知服务器特征"的黑名单：
   * 那只能挡住想得到的那些，而 root 比对是正向判据，挡住全部 —— 仓库里也不必
   * 因此留下任何具体服务器地址。
   */
  async assertIsolated(): Promise<void> {
    // 注意：不能加 -q —— 它会连 `p4 info` 的输出一起抑制掉
    const records: readonly P4Record[] = await this.p4.records(['info']);
    const info = records[0];
    if (!info) {
      throw new Error('隔离自检失败：`p4 info` 没有返回任何内容。');
    }

    const serverRoot = field(info, 'serverRoot') ?? '';
    const expected = path.resolve(this.inst.root);

    // 结构判据：实例的 root 必须落在工程的 .sandbox/ 下（防呆，与本机环境无关）
    if (!isInside(expected, SANDBOX_DIR)) {
      throw new Error(
        `隔离自检失败：实例 root 不在 .sandbox/ 目录下（${expected}）—— 沙箱数据必须留在工程内。`,
      );
    }

    if (!samePath(serverRoot, expected)) {
      throw new Error(
        [
          '隔离自检失败：服务器 root 不是本实例目录。',
          `  Server root:    ${serverRoot || '(空)'}`,
          `  期望:           ${this.inst.root}`,
          `  Server address: ${field(info, 'serverAddress') ?? '(空)'}`,
          '  说明当前连的不是本沙箱实例 —— 请检查参数层与环境层的覆盖是否被绕过。',
        ].join('\n'),
      );
    }
  }

  /**
   * 重置到基线。
   * - 默认：从模板目录秒级恢复服务器数据库，并重建工作区
   * - `hard: true`：丢弃模板，重新 seed 一份（夹具定义变更后用）
   */
  async reset(options: { hard?: boolean } = {}): Promise<void> {
    const port = this.port;
    await this.#server.stop();

    const useTemplate = !options.hard && existsSync(TEMPLATE_DIR);

    await rmrf(this.inst.root);
    await rmrf(this.inst.wsRoot);

    if (useTemplate) {
      await cp(TEMPLATE_DIR, this.inst.root, { recursive: true });
    } else {
      await rmrf(this.inst.journal);
      await rmrf(this.inst.log);
      await rmrf(this.inst.pidFile);
      await rmrf(this.inst.tickets);
      await rmrf(this.inst.enviro);
      await rmrf(this.inst.trust);
    }

    this.#server = await P4dServer.start({
      inst: this.inst,
      port,
      ...(useTemplate ? {} : { templateDir: undefined }),
    });

    if (!useTemplate) {
      await seedSandbox(this.#server.p4, this.inst, this.#seedOptions);
    }

    // 无论是从模板恢复还是重新 seed，client 的 Root 都需要指回本实例
    await this.#prepareWorkspace(useTemplate);
    await this.assertIsolated();
  }

  async stop(): Promise<void> {
    await this.#server.stop();
  }

  /** 删除实例的全部数据（测试收尾用；常驻沙箱会保留工作区目录） */
  async dispose(): Promise<void> {
    await this.#server.stop();
    await removeInstance(this.inst);
    if (!this.#resident) {
      await rmrf(this.inst.baseDir);
    }
  }

  /** 供被测工具接入的句柄 */
  handle(client: string = DEFAULT_CLIENT): SandboxHandle {
    const identity: P4Identity = { port: this.port, user: DEFAULT_USER, client };
    const clientRoot = path.join(this.inst.wsRoot, client);
    const self = this;

    return {
      port: this.port,
      user: DEFAULT_USER,
      client,
      clientRoot,
      wsRoot: this.inst.wsRoot,
      env: () => buildP4Env(identity, self.inst),
      p4: (args, options) => self.p4.run(args, { client, ...options }),
      run: (tool, args, options) =>
        new Promise((resolve) => {
          execFile(
            tool,
            [...args],
            {
              cwd: options?.cwd ?? clientRoot,
              env: buildP4Env(identity, self.inst),
              encoding: 'utf8',
              windowsHide: true,
              maxBuffer: 32 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const code: unknown = (error as NodeJS.ErrnoException | null)?.code;
              resolve({
                exitCode: error ? (typeof code === 'number' ? code : 1) : 0,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              });
            },
          );
        }),
    };
  }
}

/** 供脚本显示的工程相对路径 */
export function relativeToProject(target: string): string {
  const rel = path.relative(PROJECT_ROOT, target);
  return rel.startsWith('..') ? target : rel;
}

/** Windows 上路径不区分大小写；其它平台不折叠，免得掩盖真实差异 */
function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `child` 是否位于 `parent` 目录之内 */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 两个路径是否指向同一位置；任一侧为空一律判为不同（fail-closed） */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}
