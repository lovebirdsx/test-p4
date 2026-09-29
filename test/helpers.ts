/**
 * 用例常用辅助。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import type { P4Error, Sandbox } from '../src/index.ts';

/** 工作区里某个文件的绝对路径 */
export function wsPath(sandbox: Sandbox, relPath: string, client?: string): string {
  const root = client ? path.join(sandbox.inst.wsRoot, client) : sandbox.clientRoot;
  return path.join(root, ...relPath.split('/'));
}

export async function writeWsFile(
  sandbox: Sandbox,
  relPath: string,
  content: string,
  client?: string,
): Promise<string> {
  const target = wsPath(sandbox, relPath, client);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

export async function readWsFile(
  sandbox: Sandbox,
  relPath: string,
  client?: string,
): Promise<string> {
  const raw = await readFile(wsPath(sandbox, relPath, client), 'utf8');
  // client 的 LineEnd 是 local，Windows 上工作区文件是 CRLF；
  // 断言通常只关心文本内容，这里统一成 LF。需要精确字节时请直接用 fs.readFile。
  return raw.replace(/\r\n/g, '\n');
}

/** 断言某个 p4 命令失败，且错误信息匹配给定模式 */
export async function expectP4Failure(
  action: () => Promise<unknown>,
  pattern: RegExp,
): Promise<P4Error> {
  try {
    await action();
  } catch (error) {
    const p4Error = error as P4Error;
    const text = `${p4Error.message}\n${p4Error.result?.stderr ?? ''}`;
    expect(text).toMatch(pattern);
    return p4Error;
  }
  throw new Error(`期望命令失败，但它成功了（期望错误匹配 ${pattern}）`);
}

/** 当前已提交的最大 changelist 号 */
export async function latestChangeNumber(sandbox: Sandbox): Promise<number> {
  const records = await sandbox.p4.records(['changes', '-m', '1', '-s', 'submitted']);
  const change = records[0]?.change;
  return change === undefined ? 0 : Number.parseInt(change, 10);
}

/** 提交所有已打开的文件，返回新的 changelist 号 */
export async function submitAll(sandbox: Sandbox, description: string): Promise<number> {
  await sandbox.p4.run(['submit', '-d', description], { format: 'text', cwd: sandbox.clientRoot });
  return latestChangeNumber(sandbox);
}
