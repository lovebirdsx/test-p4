/**
 * 可选：下载官方 p4d / p4 到工程内的 vendor/ 目录，实现完全自包含与版本锁定。
 *
 * 不下载也能跑 —— 沙箱会回退到系统已安装的 Perforce（见 src/paths.ts 的探测顺序）。
 * 本脚本的价值是固定版本、脱离对 P4V 安装的依赖。
 *
 *   pnpm fetch:p4d
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VENDOR_DIR } from '../src/index.ts';

/** 与本机 p4 客户端同版本线（2024.1） */
const BASE_URL = 'https://cdist2.perforce.com/perforce/r24.1/bin.ntx64';

interface RemoteFile {
  readonly name: string;
  readonly url: string;
  /** 已知的字节数，用作完整性校验 */
  readonly size: number;
}

const FILES: readonly RemoteFile[] = [
  { name: 'p4d.exe', url: `${BASE_URL}/p4d.exe`, size: 17_496_712 },
  { name: 'p4.exe', url: `${BASE_URL}/p4.exe`, size: 11_333_256 },
];

async function download(file: RemoteFile, force: boolean): Promise<void> {
  const dest = path.join(VENDOR_DIR, file.name);
  if (existsSync(dest) && !force) {
    console.log(`已存在，跳过：${file.name}`);
    return;
  }

  console.log(`下载 ${file.url}`);
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${file.url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== file.size) {
    throw new Error(
      `下载内容大小不符：期望 ${file.size} 字节，实际 ${buffer.length} 字节。请稍后重试或手动下载。`,
    );
  }

  await mkdir(VENDOR_DIR, { recursive: true });
  await writeFile(dest, buffer);
  console.log(`已保存：vendor/${file.name}（${buffer.length} 字节）`);
}

function verify(): void {
  const p4d = path.join(VENDOR_DIR, 'p4d.exe');
  if (!existsSync(p4d)) return;
  const result = spawnSync(p4d, ['-V'], { encoding: 'utf8' });
  const version = (result.stdout ?? '').trim().split(/\r?\n/).pop();
  console.log(`校验 vendor/p4d.exe：${version ?? '(无法读取版本)'}`);
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  for (const file of FILES) {
    await download(file, force);
  }
  verify();
  console.log('\nvendor 就绪。沙箱将优先使用这里的二进制；删除 vendor/ 即回退到系统 Perforce。');
}

try {
  await main();
} catch (error) {
  console.error(`\n下载失败：${error instanceof Error ? error.message : String(error)}`);
  console.error('可以手动下载后放入 vendor/ 目录，或用 P4D_EXE / P4_EXE 环境变量指定已有路径。');
  process.exitCode = 1;
}
