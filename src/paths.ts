/**
 * 路径解析与可执行文件探测。
 *
 * 设计约束：本工程的一切运行时数据都必须落在工程目录内（`.sandbox/`），
 * 便于整体删除、复制与 gitignore。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 工程根目录（src/ 的上一级） */
export const PROJECT_ROOT = path.resolve(HERE, '..');

/** 全部运行时数据的容器目录 */
export const SANDBOX_DIR = path.join(PROJECT_ROOT, '.sandbox');

/** 可选的本地二进制目录（`pnpm fetch:p4d` 下载到这里，优先级最高） */
export const VENDOR_DIR = path.join(PROJECT_ROOT, 'vendor');

/** seed 完成后生成的服务器模板快照，用于秒级重置 */
export const TEMPLATE_DIR = path.join(SANDBOX_DIR, 'template');

/** 常驻沙箱的状态文件 */
export const STATE_FILE = path.join(SANDBOX_DIR, 'sandbox.json');

/** 工程内空 ignore 文件：覆盖本机全局的 P4IGNORE，避免 add/reconcile 被外部规则悄悄过滤 */
export const P4IGNORE_FILE = path.join(PROJECT_ROOT, '.p4ignore');

/** 沙箱默认身份 */
export const DEFAULT_USER = 'sandbox';
export const DEFAULT_CLIENT = 'sandbox_main';
export const DEFAULT_PORT = 1666;

/** 一个沙箱实例涉及的所有路径 */
export interface InstancePaths {
  readonly name: string;
  /** 实例根目录（其余路径都在它下面） */
  readonly baseDir: string;
  /** p4d 的 `-r` 根：db.* 与 depot 的物理文件 */
  readonly root: string;
  /** p4d 的 `-J` journal */
  readonly journal: string;
  /** p4d 的 `-L` 错误日志 */
  readonly log: string;
  /** p4d 的 `--pid-file` */
  readonly pidFile: string;
  /** 票据文件（P4TICKETS，隔离于本机全局票据） */
  readonly tickets: string;
  /** 配置源文件（P4ENVIRO，隔离于 `p4 set` 的全局存储） */
  readonly enviro: string;
  /** SSL 信任文件（P4TRUST，隔离于本机全局信任库） */
  readonly trust: string;
  /** client workspace 的映射根目录 */
  readonly wsRoot: string;
}

/**
 * 把实例的运行时文件放在 `baseDir` 下。
 * `root`（即 `server/`）是模板复制的对象，所以 journal/log/pid/票据都刻意放在它**外面**，
 * 保证模板永远是干净的纯数据库。
 */
export function instancePaths(baseDir: string, name: string): InstancePaths {
  return {
    name,
    baseDir,
    root: path.join(baseDir, 'server'),
    journal: path.join(baseDir, 'journal'),
    log: path.join(baseDir, 'log.txt'),
    pidFile: path.join(baseDir, 'server.pid'),
    tickets: path.join(baseDir, '.p4tickets'),
    enviro: path.join(baseDir, '.p4enviro'),
    trust: path.join(baseDir, '.p4trust'),
    wsRoot: path.join(baseDir, 'ws'),
  };
}

/** 常驻沙箱（`pnpm sandbox:up` 使用，端口固定，便于 P4V 连接） */
export function residentPaths(): InstancePaths {
  return instancePaths(SANDBOX_DIR, 'resident');
}

/** 测试用的一次性实例 */
export function tempInstancePaths(name: string): InstancePaths {
  return instancePaths(path.join(SANDBOX_DIR, 'instances', name), name);
}

function firstExisting(candidates: readonly (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/** 在 PATH 中查找可执行文件（Windows 下补 .exe/.cmd/.bat） */
function pathLookup(exe: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, exe + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const P4D_HINT = [
  '未找到 p4d 服务端可执行文件。按优先级依次查找：',
  '  1. 环境变量 P4D_EXE 指定的路径',
  `  2. ${path.join(VENDOR_DIR, 'p4d.exe')}（可运行 \`pnpm fetch:p4d\` 下载官方 r24.1 版本）`,
  '  3. C:\\Program Files\\Perforce\\DVCS\\p4d.exe（P4V 附带，确认是完整功能版 p4d）',
  '  4. PATH 中的 p4d',
].join('\n');

/** 解析 p4d 可执行文件路径；找不到时抛出带指引的错误 */
export function resolveP4dExe(): string {
  const fromEnv = process.env.P4D_EXE;
  const found = firstExisting([
    fromEnv && existsSync(fromEnv) ? fromEnv : undefined,
    path.join(VENDOR_DIR, 'p4d.exe'),
    'C:\\Program Files\\Perforce\\DVCS\\p4d.exe',
    'C:\\Program Files\\Perforce\\p4d.exe',
    pathLookup('p4d'),
  ]);
  if (!found) throw new Error(P4D_HINT);
  return found;
}

const P4_HINT = [
  '未找到 p4 客户端可执行文件。按优先级依次查找：',
  '  1. 环境变量 P4_EXE 指定的路径',
  `  2. ${path.join(VENDOR_DIR, 'p4.exe')}（可运行 \`pnpm fetch:p4d\` 下载）`,
  '  3. C:\\Program Files\\Perforce\\p4.exe',
  '  4. PATH 中的 p4',
].join('\n');

/** 解析 p4 客户端可执行文件路径；找不到时抛出带指引的错误 */
export function resolveP4Exe(): string {
  const fromEnv = process.env.P4_EXE;
  const found = firstExisting([
    fromEnv && existsSync(fromEnv) ? fromEnv : undefined,
    path.join(VENDOR_DIR, 'p4.exe'),
    'C:\\Program Files\\Perforce\\p4.exe',
    pathLookup('p4'),
  ]);
  if (!found) throw new Error(P4_HINT);
  return found;
}

/** 把 `//depot/main/a.txt` 转成 client 工作区里的绝对路径 */
export function workspaceFilePath(wsRoot: string, client: string, depotPath: string): string {
  const rel = depotPath.replace(/^\/\//, '').split('/').slice(1).join('/');
  return path.join(wsRoot, client, ...rel.split('/'));
}
