/**
 * 沙箱管理 CLI。
 *
 *   pnpm sandbox:up            启动常驻沙箱（默认端口 1666，可用 P4V 直接连）
 *   pnpm sandbox:down          停止常驻沙箱
 *   pnpm sandbox:status        查看状态
 *   pnpm sandbox:reset         从模板秒级恢复到基线
 *   pnpm sandbox:reset --hard  丢弃模板重新 seed
 *   pnpm sandbox:snapshot      重新生成模板
 *   pnpm sandbox:clean         清理残留的测试实例
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  INSTANCES_DIR,
  STATE_FILE,
  Sandbox,
  TEMPLATE_DIR,
  ensureTemplate,
  relativeToProject,
  residentPaths,
  zombieCheck,
  type SandboxHandle,
} from '../src/index.ts';

interface ResidentState {
  readonly port: number;
  readonly startedAt: string;
  readonly pid?: number;
}

async function readState(): Promise<ResidentState | undefined> {
  if (!existsSync(STATE_FILE)) return undefined;
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as ResidentState;
  } catch {
    return undefined;
  }
}

async function writeState(state: ResidentState): Promise<void> {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function printConnectionInfo(handle: SandboxHandle, label: string, rootPath: string): void {
  console.log('');
  console.log(`  ${label}`);
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  P4PORT     127.0.0.1:${handle.port}`);
  console.log(`  P4USER     ${handle.user}`);
  console.log(`  P4CLIENT   ${handle.client}`);
  console.log(`  工作区     ${relativeToProject(handle.clientRoot)}`);
  console.log(`  服务器根   ${relativeToProject(rootPath)}`);
  console.log('');
  console.log(`  用 P4V 连接：新建 Connection，Server 填 127.0.0.1:${handle.port}`);
  console.log(`              User 填 ${handle.user}，然后浏览 //depot/main/...`);
  console.log('');
}

function parseArgs(argv: readonly string[]): { command: string; flags: Set<string>; port?: number } {
  const [command = 'status', ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const portIndex = rest.indexOf('--port');
  const portRaw = portIndex === -1 ? undefined : rest[portIndex + 1];
  const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : undefined;
  return {
    command,
    flags,
    ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
  };
}

async function cmdUp(port?: number): Promise<void> {
  const existing = await readState();
  if (existing) {
    const probe = Sandbox.attach(residentPaths(), existing.port);
    if (await probe.server.isRunning()) {
      console.log(`常驻沙箱已在运行（端口 ${existing.port}，启动于 ${existing.startedAt}）。`);
      printConnectionInfo(probe.handle(), '当前沙箱连接信息', residentPaths().root);
      return;
    }
    console.log('发现过期的状态文件，将重新启动。');
  }

  console.log('正在启动常驻沙箱……（首次运行需要 seed 一份基线，约数秒）');
  const sandbox = await Sandbox.start({ resident: true, ...(port !== undefined ? { port } : {}) });
  const pid = await sandbox.server.readPid();
  await writeState({
    port: sandbox.port,
    startedAt: new Date().toISOString(),
    ...(pid !== undefined ? { pid } : {}),
  });

  printConnectionInfo(sandbox.handle(), '沙箱已就绪', residentPaths().root);
  console.log('  重置到基线：pnpm sandbox:reset');
  console.log('');
}

async function cmdDown(): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log('没有正在运行的常驻沙箱（未找到状态文件）。');
    return;
  }
  const sandbox = Sandbox.attach(residentPaths(), state.port);
  await sandbox.stop();
  await rm(STATE_FILE, { force: true });
  console.log(`常驻沙箱已停止（端口 ${state.port}）。数据仍保留在 .sandbox/ 下。`);
}

async function cmdStatus(): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log('常驻沙箱未启动。运行 `pnpm sandbox:up` 启动。');
  } else {
    const sandbox = Sandbox.attach(residentPaths(), state.port);
    const running = await sandbox.server.isRunning();
    console.log(`状态：${running ? '运行中' : '已停止（状态文件残留）'}`);
    console.log(`端口：${state.port}`);
    console.log(`启动于：${state.startedAt}`);
    if (running) {
      const pid = await sandbox.server.readPid();
      if (pid !== undefined) console.log(`PID：${pid}`);
    }
  }

  const templateExists = existsSync(TEMPLATE_DIR);
  console.log(`模板：${templateExists ? relativeToProject(TEMPLATE_DIR) : '尚未生成（首次启动时自动创建）'}`);

  const zombies = await zombieCheck(INSTANCES_DIR);
  if (zombies.length > 0) {
    console.log(`残留测试实例（仍存活）：${zombies.join(', ')}`);
    console.log('  可用 `pnpm sandbox:clean` 清理。');
  }
}

async function cmdReset(hard: boolean): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log('常驻沙箱未启动，请先运行 `pnpm sandbox:up`。');
    process.exitCode = 1;
    return;
  }
  const sandbox = Sandbox.attach(residentPaths(), state.port);
  console.log(`正在${hard ? '重新 seed' : '从模板恢复'}……`);
  const startedAt = Date.now();
  await sandbox.reset({ hard });
  await writeState({ port: sandbox.port, startedAt: new Date().toISOString() });
  console.log(`完成，用时 ${Date.now() - startedAt} ms。`);
  printConnectionInfo(sandbox.handle(), '沙箱已恢复到基线', residentPaths().root);
}

async function cmdSnapshot(): Promise<void> {
  const state = await readState();
  if (state) {
    const sandbox = Sandbox.attach(residentPaths(), state.port);
    if (await sandbox.server.isRunning()) {
      console.log('先停止常驻沙箱（模板必须从停止状态的数据库复制）……');
      await sandbox.stop();
    }
  }
  console.log('重新生成模板……');
  await rm(TEMPLATE_DIR, { recursive: true, force: true });
  await ensureTemplate();
  console.log(`模板已生成：${relativeToProject(TEMPLATE_DIR)}`);

  if (state) {
    console.log('重新启动常驻沙箱……');
    const sandbox = await Sandbox.start({ resident: true, port: state.port });
    await writeState({ port: sandbox.port, startedAt: new Date().toISOString() });
    printConnectionInfo(sandbox.handle(), '沙箱已就绪', residentPaths().root);
  }
}

async function cmdClean(): Promise<void> {
  const alive = await zombieCheck(INSTANCES_DIR);
  for (const name of alive) {
    const pidFile = `${INSTANCES_DIR}/${name}/server.pid`;
    try {
      const raw = await readFile(pidFile, 'utf8');
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid)) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        console.log(`已结束残留实例进程：${name}（PID ${pid}）`);
      }
    } catch {
      // 忽略：进程可能已退出
    }
  }
  if (existsSync(INSTANCES_DIR)) {
    await rm(INSTANCES_DIR, { recursive: true, force: true });
  }
  console.log('已清理测试实例目录（模板与常驻沙箱数据保留）。');
}

async function main(): Promise<void> {
  const { command, flags, port } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'up':
      await cmdUp(port);
      break;
    case 'down':
      await cmdDown();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'reset':
      await cmdReset(flags.has('--hard'));
      break;
    case 'snapshot':
      await cmdSnapshot();
      break;
    case 'clean':
      await cmdClean();
      break;
    default:
      console.log('用法：pnpm sandbox:<up|down|status|reset|snapshot|clean> [--hard] [--port N]');
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n执行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
