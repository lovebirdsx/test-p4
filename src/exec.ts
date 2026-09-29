/**
 * p4 客户端的子进程封装。
 *
 * 所有对 p4 的调用都必须经过这里 —— 因为这里是"隔离四层防护"的落点：
 *   1. 命令行层：无条件在参数最前面追加 `-p 127.0.0.1:<port>`（p4 的优先级最高层）
 *   2. 环境层：见 env.ts 的 buildP4Env
 *   3. 参数层：拒绝任何指向沙箱之外的端口目标（见 env.ts 的 assertNoRemoteTarget）
 *   4. 自检层：连上之后核对服务器 root 是否为本实例（见 sandbox.ts 的 assertIsolated）
 */
import { execFile } from 'node:child_process';
import { buildP4Env, assertSandboxOwnsGlobalOptions, type P4Identity } from './env.ts';
import { parseTaggedOutput, type P4Record } from './parse.ts';
import { resolveP4Exe, type InstancePaths } from './paths.ts';

/** 一次 p4 调用的结果 */
export interface P4Result {
  /** 完整命令行（含沙箱自动追加的全局选项），便于失败时诊断 */
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** `-z tag` 格式下的结构化记录；text 格式时为空数组 */
  readonly records: readonly P4Record[];
  readonly durationMs: number;
}

/** p4 以非 0 退出且调用方未声明允许失败时抛出 */
export class P4Error extends Error {
  readonly result: P4Result;
  constructor(message: string, result: P4Result) {
    super(message);
    this.name = 'P4Error';
    this.result = result;
  }
}

export interface RunP4Options {
  /** 工作目录；需要 client 映射的命令应传工作区路径 */
  readonly cwd?: string;
  /** 写入 stdin 的内容（用于 `-i` 表单提交） */
  readonly input?: string;
  /** 输出解析方式，默认 `ztag` */
  readonly format?: 'text' | 'ztag';
  /** 追加 `-q`，抑制 info 级消息（只要结构化数据时用） */
  readonly quiet?: boolean;
  /** 追加 `-s`，给每行输出加 error/warning/info/text/exit 前缀（与 ztag 互斥） */
  readonly severity?: boolean;
  /** 允许非 0 退出而不抛错（用于断言"这个操作应当失败"） */
  readonly allowFailure?: boolean;
  /**
   * 覆盖本次调用使用的 client，注入到**全局**选项位置。
   * 注意区分：全局 `-c` 是 client（工作区），而命令之后的 `-c` 是 changelist 号。
   */
  readonly client?: string;
  readonly timeoutMs?: number;
}

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

interface RawExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: Error;
}

function rawExec(
  exe: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
): Promise<RawExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      exe,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          const code: unknown = (error as NodeJS.ErrnoException).code;
          exitCode = typeof code === 'number' ? code : 1;
        }
        resolve({
          exitCode,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          ...(error ? { spawnError: error } : {}),
        });
      },
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input, 'utf8');
    } else {
      child.stdin?.end();
    }
  });
}

/** 绑定到某个沙箱实例的 p4 客户端 */
export class P4Cli {
  readonly identity: P4Identity;
  readonly paths: InstancePaths;
  readonly exe: string;

  constructor(identity: P4Identity, paths: InstancePaths) {
    this.identity = identity;
    this.paths = paths;
    this.exe = resolveP4Exe();
  }

  /**
   * 执行一条 p4 命令。
   * `args` 只应包含**命令及其子参数**（如 `['changes', '-m', '5']`），
   * 全局选项与端口由沙箱负责注入。
   */
  async run(args: readonly string[], options: RunP4Options = {}): Promise<P4Result> {
    assertSandboxOwnsGlobalOptions(args);

    const format = options.format ?? 'ztag';
    if (options.severity && format === 'ztag') {
      throw new Error('`-s`（severity 前缀）与 `-z tag` 不能同时使用：前缀会破坏 tag 行的解析。');
    }

    // 注入必须排在参数最前面：p4 只把**命令之前**的选项当全局选项，而重复的全局
    // 选项里**第一个生效**（均已实测）。调用方不得自带全局选项 —— 见
    // assertSandboxOwnsGlobalOptions。
    const globalArgs: string[] = ['-p', `127.0.0.1:${this.identity.port}`, '-u', this.identity.user];
    const client = options.client ?? this.identity.client;
    if (client) globalArgs.push('-c', client);
    // 显式声明工作目录，双保险（另一个保险是 env.ts 里删掉 $PWD）
    if (options.cwd) globalArgs.push('-d', options.cwd);
    if (options.quiet) globalArgs.push('-q');
    if (options.severity) globalArgs.push('-s');
    if (format === 'ztag') globalArgs.push('-z', 'tag');

    const argv = [...globalArgs, ...args];
    const startedAt = Date.now();
    const raw = await rawExec(this.exe, argv, {
      cwd: options.cwd,
      env: buildP4Env(this.identity, this.paths),
      input: options.input,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;

    const result: P4Result = {
      argv,
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      records: format === 'ztag' ? parseTaggedOutput(raw.stdout) : [],
      durationMs,
    };

    if (raw.exitCode !== 0 && !options.allowFailure) {
      throw new P4Error(formatP4Failure(result, raw.spawnError), result);
    }
    return result;
  }

  /** 便捷方法：执行并直接返回结构化记录 */
  async records(args: readonly string[], options: RunP4Options = {}): Promise<readonly P4Record[]> {
    const result = await this.run(args, { ...options, format: 'ztag' });
    return result.records;
  }

  /** 便捷方法：执行并返回原始文本输出 */
  async text(args: readonly string[], options: RunP4Options = {}): Promise<string> {
    const result = await this.run(args, { ...options, format: 'text', quiet: true });
    return result.stdout.trimEnd();
  }
}

function formatP4Failure(result: P4Result, spawnError?: Error): string {
  const parts = [
    `p4 命令失败（退出码 ${result.exitCode}）`,
    `  命令：p4 ${result.argv.join(' ')}`,
  ];
  if (spawnError && result.exitCode !== 0 && !result.stderr) {
    parts.push(`  进程错误：${spawnError.message}`);
  }
  const stderr = result.stderr.trim();
  if (stderr) parts.push(`  stderr：\n${indent(stderr)}`);
  const stdout = result.stdout.trim();
  if (stdout) parts.push(`  stdout：\n${indent(stdout)}`);
  return parts.join('\n');
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}
