/**
 * 标准测试夹具：从一个空的 p4d root 建出可用的 depot / 用户 / 工作区 / 提交历史。
 *
 * 夹具刻意覆盖了几类容易出问题的场景：多层目录、中文文件名、二进制文件、
 * 文件删除、二次修改、以及一个部分映射的第二个工作区。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { P4Cli } from './exec.ts';
import { DEFAULT_CLIENT, DEFAULT_USER, type InstancePaths } from './paths.ts';

/** depot 定义 */
export interface DepotDefinition {
  readonly name: string;
  readonly type: 'local' | 'stream';
  readonly description: string;
}

/** client 工作区定义 */
export interface ClientDefinition {
  readonly name: string;
  readonly description: string;
  /** View 行，不含前导 tab */
  readonly view: readonly string[];
}

/** 一步提交：先落盘文件，再 add/edit/delete，最后 submit */
export interface SeedStep {
  readonly message: string;
  readonly add?: readonly SeedFile[];
  readonly edit?: readonly SeedFile[];
  readonly delete?: readonly string[];
}

export interface SeedFile {
  /** 相对于工作区根的路径，用 `/` 分隔 */
  readonly path: string;
  readonly content: string | Uint8Array;
}

export const DEFAULT_DEPOTS: readonly DepotDefinition[] = [
  { name: 'depot', type: 'local', description: '本地测试主 depot' },
];

export const DEFAULT_CLIENTS: readonly ClientDefinition[] = [
  {
    name: DEFAULT_CLIENT,
    description: '沙箱主工作区：完整映射 //depot/main',
    view: [`//depot/main/... //${DEFAULT_CLIENT}/...`],
  },
  {
    name: 'sandbox_src',
    description: '沙箱副工作区：只映射 src 子目录，用于验证部分映射与工作区隔离',
    view: [`//depot/main/src/... //sandbox_src/src/...`],
  },
];

/** 默认提交历史：4 步，覆盖新增 / 修改 / 删除 */
export const DEFAULT_HISTORY: readonly SeedStep[] = [
  {
    message: '初始导入：建立基础文件集',
    add: [
      { path: 'src/hello.txt', content: 'Hello, Perforce.\n' },
      { path: 'src/util.txt', content: 'util v1\n' },
      { path: 'docs/readme.md', content: '# 沙箱仓库\n\n用于本地机制测试。\n' },
      { path: 'docs/old.txt', content: '这个文件稍后会被删除\n' },
      { path: 'bin/data.bin', content: Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a]) },
    ],
  },
  {
    message: '修改 hello.txt 与 util.txt',
    edit: [
      { path: 'src/hello.txt', content: 'Hello, Perforce.\n第二行是新增的。\n' },
      { path: 'src/util.txt', content: 'util v2\n' },
    ],
  },
  {
    message: '删除已废弃的 old.txt',
    delete: ['docs/old.txt'],
  },
  {
    message: '新增中文文件名与深层目录文件',
    add: [
      { path: 'docs/说明文档.txt', content: '中文文件名用于验证字符集处理。\n' },
      { path: 'src/deep/nested/level/leaf.txt', content: 'deep file\n' },
    ],
  },
];

export interface SeedOptions {
  readonly user?: string;
  readonly depots?: readonly DepotDefinition[];
  readonly clients?: readonly ClientDefinition[];
  readonly history?: readonly SeedStep[];
  /** 追加 typemap（含 +S 独占签出规则） */
  readonly includeTypemap?: boolean;
}

export interface SeedResult {
  /** 依次创建的 changelist 号 */
  readonly changes: readonly number[];
  readonly clients: readonly string[];
  readonly depots: readonly string[];
}

function userForm(user: string): string {
  // 注意：user spec 没有 Description 字段（实测带该字段会报 Unknown field name）
  return [
    `User:\t${user}`,
    '',
    'Email:\tsandbox@example.invalid',
    '',
    'FullName:\tSandbox Tester',
    '',
  ].join('\n');
}

function depotForm(depot: DepotDefinition): string {
  return [
    `Depot:\t${depot.name}`,
    '',
    `Type:\t${depot.type}`,
    '',
    'Description:',
    `\t${depot.description}`,
    '',
  ].join('\n');
}

function clientForm(client: ClientDefinition, root: string, owner: string): string {
  // Owner 必须显式写：不写的话数据库里该字段为空，
  // 之后 `p4 clients -u <user>` 这类按 owner 过滤的查询会查不到任何工作区。
  return [
    `Client:\t${client.name}`,
    '',
    `Owner:\t${owner}`,
    '',
    'Description:',
    `\t${client.description}`,
    '',
    `Root:\t${root}`,
    '',
    'Options:\tnoallwrite noclobber nocompress unlocked nomodtime normdir',
    '',
    'SubmitOptions:\tsubmitunchanged',
    '',
    'LineEnd:\tlocal',
    '',
    'View:',
    ...client.view.map((line) => `\t${line}`),
    '',
  ].join('\n');
}

const TYPEMAP_FORM = [
  '# 字段名是 TypeMap（不是 Typemap）',
  'TypeMap:',
  '',
  '\tbinary+l //depot/main/bin/...',
  '',
  '\ttext+S //depot/main/src/critical/...',
  '',
].join('\n');

/** 工作区里某个文件的绝对路径 */
function wsFile(inst: InstancePaths, client: string, relPath: string): string {
  return path.join(inst.wsRoot, client, ...relPath.split('/'));
}

async function writeWorkspaceFile(absPath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, content);
}

/** 查询最新的已提交 changelist 号 */
async function latestChange(p4: P4Cli): Promise<number | undefined> {
  const records = await p4.records(['changes', '-m', '1', '-s', 'submitted']);
  const change = records[0]?.change;
  if (change === undefined) return undefined;
  const parsed = Number.parseInt(change, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 从空 root 建出标准夹具。可重复调用（幂等性有限：重复调用会在已有历史上继续追加提交）。
 */
export async function seedSandbox(
  p4: P4Cli,
  inst: InstancePaths,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const user = options.user ?? DEFAULT_USER;
  const depots = options.depots ?? DEFAULT_DEPOTS;
  const clients = options.clients ?? DEFAULT_CLIENTS;
  const history = options.history ?? DEFAULT_HISTORY;

  // 1) 用户（空库时首次连接会自动建用户，这里显式写出以固定 FullName 等字段）
  await p4.run(['user', '-f', '-i'], { input: userForm(user), format: 'text' });

  // 2) depot
  const existingDepots = new Set((await p4.records(['depots'])).map((r) => r.name));
  const createdDepots: string[] = [];
  for (const depot of depots) {
    if (existingDepots.has(depot.name)) continue;
    await p4.run(['depot', '-i'], { input: depotForm(depot), format: 'text' });
    createdDepots.push(depot.name);
  }

  // 3) 可选 typemap
  if (options.includeTypemap) {
    await p4.run(['typemap', '-i'], { input: TYPEMAP_FORM, format: 'text' });
  }

  // 4) client 工作区
  for (const client of clients) {
    const root = path.join(inst.wsRoot, client.name);
    await mkdir(root, { recursive: true });
    await p4.run(['client', '-i'], { input: clientForm(client, root, user), format: 'text' });
  }

  // 5) 按步骤构造提交历史
  const changes: number[] = [];
  const primary = clients[0]?.name ?? DEFAULT_CLIENT;
  const primaryRoot = path.join(inst.wsRoot, primary);

  for (const step of history) {
    for (const file of step.add ?? []) {
      const abs = wsFile(inst, primary, file.path);
      await writeWorkspaceFile(abs, file.content);
      await p4.run(['add', file.path], { format: 'text', cwd: primaryRoot, client: primary });
    }
    for (const file of step.edit ?? []) {
      const abs = wsFile(inst, primary, file.path);
      await p4.run(['edit', file.path], { format: 'text', cwd: primaryRoot, client: primary });
      await writeWorkspaceFile(abs, file.content);
    }
    for (const relPath of step.delete ?? []) {
      await p4.run(['delete', relPath], { format: 'text', cwd: primaryRoot, client: primary });
    }

    await p4.run(['submit', '-d', step.message], { format: 'text', cwd: primaryRoot, client: primary });
    const change = await latestChange(p4);
    if (change !== undefined) changes.push(change);
  }

  // 6) 把主工作区同步到最新
  await p4.run(['sync', '//depot/main/...'], { format: 'text', cwd: primaryRoot, client: primary });

  return { changes, clients: clients.map((c) => c.name), depots: createdDepots };
}
