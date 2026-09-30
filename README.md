# test-p4

本地自包含的 **Perforce (Helix Core) 机制测试沙箱**：p4d 直接跑在本目录的 `.sandbox/` 里，
建 depot、建 client 工作区、随便折腾，然后用一条命令回到干净基线。**不依赖任何远程服务器。**

用来做三类事：

1. **基础工作流机制测试** —— changelist 生命周期、submit/revert、add/edit/delete、client 映射、sync
2. **自研工具/脚本的自动化回归** —— 被测工具零改动，由沙箱注入 `P4PORT`/`P4USER`/`P4CLIENT` 后跑起来
3. **破坏性实验与快速重置** —— 提交垃圾、删文件、制造冲突，然后 `reset` 秒级恢复

## 快速开始

```powershell
pnpm install
pnpm sandbox:up      # 首次会 seed 一份基线（约数秒），之后秒起
pnpm test            # 跑全部用例
```

`pnpm sandbox:up` 会打印连接信息。之后在**本工程目录内**敲 `p4` 命令会自动指向沙箱
（工程根的 `.p4config` 起了作用）：

```powershell
p4 info              # Server root 应指向 .sandbox\server
p4 changes -m 5 //depot/main/...
```

想用图形界面：P4V 新建 Connection，Server 填 `127.0.0.1:1666`，User 填 `sandbox`，密码留空。

更多手工实验姿势见 **[docs/recipes.md](docs/recipes.md)**。

## ⚠️ 关于隔离

开发机的全局 Perforce 配置（注册表 / `~/.p4enviro` / 某层目录下的 `.p4config`）常常指向一台真实的服务器 —— 它和本仓库无关，本仓库也不记录它。危险在于：在沙箱目录之外裸跑一次 `p4`，读到的就是那份配置。所以这套工程把"绝不误连别处"当成一等公民，防护的判据**全部是白名单式的，不含任何具体服务器地址**：

- `src/exec.ts` 无条件在命令行最前面追加 `-p 127.0.0.1:<port>`（p4 的最高优先级来源；重复的全局选项里第一个生效）
- `src/env.ts` 删掉继承来的**全部** `P4*` 变量后写入沙箱值，并用 `P4CONFIG=noconfig` 关掉"配置文件"这条来源（环境变量本身压不过 `.p4config`，实测如此）
- 调用方不得自带全局选项（`-p` / `--port` / `-u` / `-x` …）—— 判据是**位置**（命令名之前）而非值
- `src/sandbox.ts` 每次启动后自检 `serverRoot` 必须等于本实例目录，不符即抛错
- `test/isolation.test.ts` 与 `test/isolation-env-precedence.test.ts` 对这些做负向验证

**但这些防护只覆盖通过 Node API 发起的调用。** 手工敲 `p4` 时：

> ⚠️ 请务必在工程目录（或其子目录）里操作 —— 只有在这些目录下 `.p4config` 才会生效。
> 在别处敲 `p4` 会读到机器级配置，直接连上真实服务器。

另外：本工程任何代码都**不得**调用 `p4 set`（它会写注册表）、不得读写 `HKCU\Software\Perforce`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm sandbox:up` / `down` / `status` | 起停常驻沙箱（固定端口 1666，方便 P4V 连接） |
| `pnpm sandbox:reset` | 从模板恢复基线，约 0.5 秒 |
| `pnpm sandbox:reset --hard` | 丢弃模板重新 seed（改了夹具定义后用） |
| `pnpm sandbox:snapshot` | 重新生成模板 |
| `pnpm sandbox:clean` | 结束残留的测试实例进程 |
| `pnpm test` | 跑全部用例（每个测试文件一个独立实例，可并行，整套约 3 秒） |
| `pnpm test:basic` / `test:destructive` | 只跑某一类 |
| `pnpm test:watch` | 监听模式 |
| `pnpm typecheck` | 类型检查 |
| `pnpm probe:specs [名字...]` | dump 服务器默认 spec 结构（扩展夹具时用） |
| `pnpm fetch:p4d` | 下载官方 p4d/p4.exe 到 `vendor/`（可选） |

调试时设 `P4_KEEP_SANDBOX=1` 可以让用例结束后不清理，并打印端口与工作区路径，直接用 P4V 连上去看现场。
注意此时是**每个测试文件各留一个实例**，看完记得 `pnpm sandbox:clean`。

想看清时间花在哪，设 `P4_SANDBOX_TIMING=1`：每个实例会往 stderr 打一行阶段耗时汇总，
末尾的 `p4-spawns` 是本次启动了多少个 `p4.exe` —— 那才是这套东西的真正货币（见 [docs/design.md](docs/design.md) 的"性能"一节）。

## 环境要求

- **Node ≥ 24** —— 脚本直接 `node xxx.ts` 运行（依赖 Node 原生的 TypeScript 类型剥离，不需要 tsx/ts-node）
- **pnpm**
- **p4 与 p4d** —— 按以下顺序自动探测，也可以 `pnpm fetch:p4d` 下载官方 r24.1 到 `vendor/`：
  1. 环境变量 `P4_EXE` / `P4D_EXE`
  2. `vendor/p4.exe`、`vendor/p4d.exe`
  3. `C:\Program Files\Perforce\p4.exe`、`C:\Program Files\Perforce\DVCS\p4d.exe`（P4V 附带）
  4. `PATH`

## 目录结构

```
src/            沙箱实现（对外 API 见 src/index.ts）
scripts/        管理 CLI 与开发辅助
test/           Vitest 用例（basic / destructive / integration / isolation）
examples/under-test/   演示"被测工具如何接入沙箱"
docs/design.md  架构、隔离机制、踩坑记录
docs/recipes.md 手工实验手册（终端、P4V、冲突、重置、排查）
.sandbox/       [gitignore] 全部运行时数据，删掉即回到未初始化状态
```

## 在测试里用它

```ts
import { expect, test } from './fixtures.ts';
import { submitAll, writeWsFile } from './helpers.ts';

test('提交后 have rev 前进', async ({ sandbox }) => {
  await sandbox.p4.run(['edit', '//depot/main/src/util.txt'], {
    format: 'text',
    cwd: sandbox.clientRoot,
  });
  await writeWsFile(sandbox, 'src/util.txt', '新内容\n');
  await submitAll(sandbox, '用例提交');

  const fstat = await sandbox.p4.records(['fstat', '//depot/main/src/util.txt']);
  expect(fstat[0]?.haveRev).toBe('3');
});
```

每个测试文件通过 `sandbox` 夹具拿到一个独立实例（独立 root、独立端口、独立工作区）。

**会改动实例状态的用例，请让它独占一个文件** —— 每个文件本来就是从模板复制出的干净基线，
独占文件等于免费得到一次重置，而文件之间是并行的。反过来，把一个文件里塞多个破坏性用例、
每个开头再 `reset()` 一次，会让它们退化成串行（拆分前有个文件因此吃掉了整套测试 97% 的墙钟）。
同文件内只在"验证 reset 行为本身"或"确实要回到中途基线"时才调 `await sandbox.reset()`。

## 把自研工具接进来

`sandbox.handle()` 给出一个句柄，工具代码**零改动**：

```ts
const result = await sandbox.handle().run(process.execPath, ['你的工具.js', '参数']);
// 工具进程拿到的 P4PORT / P4USER / P4CLIENT 都已指向本沙箱
```

`examples/under-test/mark-tool.ts` 是一个完整样例，对应的用例在 `test/integration/external-tool.test.ts`。
