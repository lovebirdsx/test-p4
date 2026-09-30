/**
 * 沙箱门面：把 p4d 生命周期、p4 客户端、种子夹具、重置能力合成一个对象，
 * 并对外给出"被测工具接入句柄"。
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildP4Env, type P4Identity } from './env.ts';
import { P4Cli, type P4Result, type RunP4Options } from './exec.ts';
import { field, getFormField, setFormField, type P4Record } from './parse.ts';
import { P4dServer, removeInstance, rmrf, snapshotToTemplate } from './p4d.ts';
import {
  CLIENT_CACHE_FILE,
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
import { beginTiming, reportTiming, timed } from './timing.ts';

/** 运行时数据根（`.sandbox/instances/`） */
export const INSTANCES_DIR = path.join(SANDBOX_DIR, 'instances');

const TEMPLATE_INSTANCE_NAME = '__template__';

/** sidecar 缓存的结构；`version` 让结构变化时旧缓存自动失效 */
interface ClientFormCache {
  readonly version: number;
  readonly fingerprint: string;
  readonly clients: readonly { readonly name: string; readonly form: string }[];
}

const CLIENT_CACHE_VERSION = 1;

/** 模板指纹（db.domain 的大小 + 修改时间）：模板一变，缓存即失效 */
function templateFingerprint(): string | undefined {
  try {
    const stat = statSync(path.join(TEMPLATE_DIR, 'db.domain'));
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/**
 * 读模板的 client 表单缓存。
 * 缺失 / 版本不符 / 指纹不符一律返回 undefined，由调用方回退到读-改-写。
 * 注意"缓存里有 0 个 client"是合法结果（自定义夹具可能不建工作区），不是失效。
 */
async function readClientFormCache(): Promise<ClientFormCache | undefined> {
  const fingerprint = templateFingerprint();
  if (fingerprint === undefined) return undefined;
  try {
    const parsed = JSON.parse(await readFile(CLIENT_CACHE_FILE, 'utf8')) as ClientFormCache;
    if (parsed.version !== CLIENT_CACHE_VERSION) return undefined;
    if (parsed.fingerprint !== fingerprint) return undefined;
    if (!Array.isArray(parsed.clients)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 把服务器产出的 client 表单原文写入 sidecar */
async function writeClientFormCache(clients: ClientFormCache['clients']): Promise<void> {
  const fingerprint = templateFingerprint();
  if (fingerprint === undefined) return;
  const payload: ClientFormCache = { version: CLIENT_CACHE_VERSION, fingerprint, clients };
  await writeFile(CLIENT_CACHE_FILE, JSON.stringify(payload), 'utf8');
}

/**
 * 读全部 client 的表单**原文**。
 *
 * 必须在模板快照之前、服务器还活着时调用。原文必须由服务器产出（`p4 client -o`），
 * 不能拿 `seed.ts` 的 `clientForm()` 本地重拼：p4d 存 spec 时会做规范化
 * （实测 `Options` 会多出 seed 没写的 `noaltsync`），自拼的表单会把未列出的字段
 * 悄悄改回默认值，而这种错误在测试里是完全静默的。
 */
async function captureClientForms(p4: P4Cli): Promise<ClientFormCache['clients']> {
  const clients: { name: string; form: string }[] = [];
  for (const record of await p4.records(['clients'])) {
    const name = field(record, 'client');
    if (!name) continue;
    const form = (await p4.run(['client', '-o', name], { format: 'text' })).stdout;
    clients.push({ name, form });
  }
  return clients;
}

/**
 * 保证模板存在：模板是所有实例的"干净基线"，缺失时用一个临时实例 seed 一份。
 * 这是唯一会跑完整 seed 的地方，因此把它放在 vitest 的 globalSetup 里只跑一次。
 */
export async function ensureTemplate(seedOptions: SeedOptions = {}): Promise<void> {
  // 模板连同它的 client 表单 sidecar 一起构成"干净基线"。sidecar 缺失或失配时
  // 重建整份模板 —— 这样已有的旧模板会自动升级，不需要手工删目录。重建只发生在
  // globalSetup 里，一次性成本换来的是此后每个实例少 3 次 p4 往返。
  if (existsSync(TEMPLATE_DIR) && (await readClientFormCache()) !== undefined) return;

  const inst = tempInstancePaths(TEMPLATE_INSTANCE_NAME);
  await removeInstance(inst);

  const server = await P4dServer.start({ inst });
  let clientForms: ClientFormCache['clients'] = [];
  try {
    await seedSandbox(server.p4, inst, seedOptions);
    // 必须在停服务器之前读 —— 停完之后 client spec 就只剩数据库文件里的形态了
    clientForms = await captureClientForms(server.p4);
  } finally {
    await server.stop();
  }

  await snapshotToTemplate(inst, TEMPLATE_DIR);
  // 指纹取自刚快照出来的模板，所以必须写在 snapshotToTemplate 之后
  await writeClientFormCache(clientForms);
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
    const startedAt = Date.now();
    beginTiming();
    const resident = options.resident ?? false;
    const inst = resident
      ? residentPaths()
      : tempInstancePaths(
          options.name ?? `t${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        );

    if (!existsSync(inst.root)) {
      await timed('template', () => ensureTemplate(options.seedOptions ?? {}));
    }

    // 常驻沙箱默认固定端口，方便 P4V 直接连；被占用时会自动改用空闲端口（见 CLI 输出）
    const port = options.port ?? (resident ? DEFAULT_PORT : undefined);
    const server = await timed('p4d-start', () =>
      P4dServer.start({
        inst,
        ...(port !== undefined ? { port } : {}),
        templateDir: TEMPLATE_DIR,
      }),
    );

    const sandbox = new Sandbox(inst, server, options.seedOptions ?? {}, resident);
    try {
      await sandbox.#prepareWorkspace({ sync: options.syncWorkspace ?? true, retarget: true });
      if (!options.skipIsolationCheck) {
        await sandbox.assertIsolated();
      }
    } catch (error) {
      // 启动中途失败时必须把已经拉起来的 p4d 收掉，否则每失败一次就漏一个孤儿进程 ——
      // 而"隔离自检不通过"恰恰是最需要干净退场的时候。
      // 一次性实例连目录一起清掉；常驻沙箱只停进程、保留数据（不该因为一次启动失败被清空）。
      await (resident ? server.stop({ force: true }) : sandbox.dispose()).catch(() => undefined);
      throw error;
    }
    reportTiming(`start ${inst.name}`, Date.now() - startedAt);
    return sandbox;
  }

  /**
   * 模板里的 client spec 记录的是**模板实例**的绝对路径；复制到新实例后必须把 Root
   * 改回本实例的工作区目录，否则 p4 会把文件同步到早已被删除的模板目录里。
   */
  async #retargetClients(): Promise<void> {
    await timed('retarget', async () => {
      // 快路径：模板的 sidecar 缓存。每个 client 只需一次 `client -i`，
      // 即 2 次往返，而不是"列 client + 每个 client 读一次表单 + 写回"= 5 次。
      const cached = await readClientFormCache();
      if (cached) {
        for (const { name, form } of cached.clients) {
          await this.#applyClientRoot(name, form);
        }
        return;
      }

      // 回退路径：缓存缺失或已失效（例如模板是旧版本生成的）
      // 不要加 `-u <user>` 过滤：owner 字段在某些情况下为空会导致查不到任何工作区
      for (const record of await this.p4.records(['clients'])) {
        const name = field(record, 'client');
        if (!name) continue;
        const form = (await this.p4.run(['client', '-o', name], { format: 'text' })).stdout;
        await this.#applyClientRoot(name, form);
      }
    });
  }

  /** 把 client 的 Root 指回本实例；已经指对了就什么都不做 */
  async #applyClientRoot(name: string, form: string): Promise<void> {
    const target = path.join(this.inst.wsRoot, name);
    const current = getFormField(form, 'Root');
    if (current && path.resolve(current) === path.resolve(target)) return;
    await this.p4.run(['client', '-i'], {
      input: setFormField(form, 'Root', target),
      format: 'text',
    });
  }

  /**
   * 让工作区真正有文件。
   * 注意必须用 `sync -f`：从模板复制来的 have list 声称文件已同步，普通 sync 会认为
   * 无事可做，而磁盘上其实什么都没有。
   */
  async #syncWorkspace(): Promise<void> {
    await timed('sync', async () => {
      const root = path.join(this.inst.wsRoot, DEFAULT_CLIENT);
      await mkdir(root, { recursive: true });
      await this.p4.run(['sync', '-f', '//depot/main/...'], {
        format: 'text',
        cwd: root,
        client: DEFAULT_CLIENT,
      });
    });
  }

  async #prepareWorkspace(options: { sync: boolean; retarget: boolean }): Promise<void> {
    if (options.retarget) await this.#retargetClients();
    if (options.sync) await this.#syncWorkspace();
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
    await timed('selfcheck', () => this.#assertIsolated());
  }

  async #assertIsolated(): Promise<void> {
    // 就绪探测时已经抓过一次 `p4 info`（见 P4dServer.lastInfo），直接复用那条记录，
    // 省掉启动流程里的一次 p4 往返。判据本身一字未改 —— 只是把"什么时候取数据"
    // 从"每次自检都取"改成"启动时取一次"。
    //
    // 没有缓存时必须现查（`Sandbox.attach()` 路径从未跑过就绪探测）。缓存挂在
    // `P4dServer` 实例上，而 `reset()` 会换一个 server 实例，所以缓存不会过期失效。
    //
    // 注意：现查时不能加 `-q` —— 它会连 `p4 info` 的输出一起抑制掉。
    const cached = this.#server.lastInfo;
    const info: P4Record | undefined = cached ?? (await this.p4.records(['info']))[0];
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
    const startedAt = Date.now();
    beginTiming();
    const port = this.port;
    // 数据库马上会被模板覆盖，不必等 p4d 花约 950ms 做干净收尾
    await timed('stop', () => this.#server.stop({ force: true }));

    const useTemplate = !options.hard && existsSync(TEMPLATE_DIR);

    await timed('fs', async () => {
      await rmrf(this.inst.root);
      await rmrf(this.inst.wsRoot);
      // 强杀后 journal 可能停在写到一半的状态。它位于 root 之外、不会被模板复制覆盖，
      // 若留着会在下次启动时被重放到新数据库上。删掉后 p4d 会新建一份 ——
      // 这与"实例首次启动"的状态完全一致（既有用例已证明该状态可行）。
      await rmrf(this.inst.journal);

      if (useTemplate) {
        await cp(TEMPLATE_DIR, this.inst.root, { recursive: true });
      } else {
        await rmrf(this.inst.log);
        await rmrf(this.inst.pidFile);
        await rmrf(this.inst.tickets);
        await rmrf(this.inst.enviro);
        await rmrf(this.inst.trust);
      }
    });

    this.#server = await timed('p4d-start', () =>
      P4dServer.start({
        inst: this.inst,
        port,
        ...(useTemplate ? {} : { templateDir: undefined }),
      }),
    );

    try {
      if (!useTemplate) {
        await timed('seed', () => seedSandbox(this.#server.p4, this.inst, this.#seedOptions));
      }

      // 从模板恢复时，client 的 Root 记的还是模板实例的路径，需要逐一指回本实例；
      // 而重新 seed 那条路 seedSandbox 刚用本实例的路径建好了 client，不需要再改。
      await this.#prepareWorkspace({ sync: useTemplate, retarget: useTemplate });
      await this.assertIsolated();
    } catch (error) {
      // 同上：重置中途失败也要把新拉起来的 p4d 收掉，别留孤儿进程
      await this.#server.stop({ force: true }).catch(() => undefined);
      throw error;
    }
    reportTiming(`reset ${this.inst.name}`, Date.now() - startedAt);
  }

  async stop(): Promise<void> {
    await this.#server.stop();
  }

  /** 删除实例的全部数据（测试收尾用；常驻沙箱会保留工作区目录） */
  async dispose(): Promise<void> {
    // 实例马上整个删掉，没有需要保留的数据库状态
    await this.#server.stop({ force: true });
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
