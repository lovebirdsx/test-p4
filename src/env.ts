/**
 * 隔离环境构造 —— 本工程的安全核心。
 *
 * ## 背景
 * 如果本机的全局 Perforce 配置（注册表 `HKCU\Software\Perforce\Environment`）或某层
 * 父目录下的 `.p4config` 指向一台真实服务器，那么在那些目录里裸跑一次 `p4` 就会连上去。
 * 所以沙箱里的每一次 p4 调用都必须把配置来源逐条截断。
 *
 * ## 优先级依据（均已实测）
 * 实测顺序：**命令行 > P4CONFIG 文件 > 环境变量 > 注册表**。
 *   - `env P4PORT=127.0.0.1:9 p4 info` 连的是 9（而非注册表里的值）→ 环境变量压过注册表
 *   - 在写着 `P4PORT=127.0.0.1:8` 的 `.p4config` 目录里加同样的环境变量，连的是 **8**
 *     → 配置文件压过环境变量
 *   - 同样的目录里 `p4 -p 127.0.0.1:1666 info` 连的是 1666 → 命令行压过配置文件
 *
 * 两个直接后果，第 2 层的设计正基于此：
 *   1. **不能指望"环境变量覆盖"挡住 `.p4config`** —— 挡不住。真正挡住它的是
 *      `P4CONFIG=noconfig`（让 p4 去找一个根本不存在的配置文件），见 buildP4Env。
 *   2. 命令行注入的 `-p` 压过一切，是唯一无条件的保证（见 exec.ts 的第 1 层）。
 *
 * ## 禁止事项
 * 本工程的任何代码都**不得**调用 `p4 set`（它会写注册表，污染全局配置），
 * 也不得直接读写 `HKCU\Software\Perforce`。
 */
import { DEFAULT_CLIENT, P4IGNORE_FILE, type InstancePaths } from './paths.ts';

/** 一次 p4 调用所使用的身份 */
export interface P4Identity {
  readonly port: number;
  readonly user: string;
  readonly client?: string;
}

/**
 * 调用方参数必须"从命令名开始"。
 *
 * p4 只把**命令之前**的选项当作全局选项（已实测：`p4 info -p x:1` 报
 * `Usage: info [-s]`，而 `p4 -p x:1 info` 会真的去连 x:1）。全局选项是唯一能
 * 改变连接目标的东西 —— 而沙箱已经在参数最前面注入了自己的 `-p` / `-u` / `-c`，
 * 所以调用方再传任何全局选项，都只会与注入的同类选项争抢，造成覆盖或歧义。
 *
 * 这条判据**只看位置、不看值**，因此不依赖 p4 的选项表：将来 p4 新增任何全局选项
 * （从文件读参数的 `-x`、长选项 `--port`、以及各种等价写法）都同样逃不掉。
 * 反过来，检查"值长什么样"是守不住的 —— 值的形态无穷无尽，位置却只有两种。
 */
export function assertSandboxOwnsGlobalOptions(args: readonly string[]): void {
  const first = args[0];
  // 空参数交给 p4 自己报 usage，这里不越俎代庖
  if (first === undefined || !first.startsWith('-')) return;

  throw new Error(
    [
      `拒绝执行：沙箱不接受调用方传入全局选项（首个参数是 ${first}）。`,
      `  命令：p4 ${args.join(' ')}`,
      '  p4 会把命令之前的选项当作全局选项，覆盖沙箱注入的连接目标。',
      '  需要指定工作区请用 RunP4Options.client；需要指定实例请用 Sandbox.attach()。',
    ].join('\n'),
  );
}

/**
 * 构造传给 p4/p4d 子进程的干净环境。
 *
 * 先清空所有继承来的 `P4*` / `P4_*` 变量，再写入沙箱专用值 —— 这样即使将来
 * 有人在系统里新增了别的 P4 变量，也不会悄悄泄漏进沙箱。
 */
export function buildP4Env(identity: P4Identity, inst: InstancePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // 大小写不敏感地清：Windows 的环境变量名不区分大小写，小写的 `p4port` 同样要清掉，
    // 否则它会与下面注入的 `P4PORT` 在子进程的环境块里撞名
    if (key.toUpperCase().startsWith('P4')) delete env[key];
  }
  // p4 会用 $PWD 判断"当前目录"，而它会盖过子进程的真实 cwd（例如从 bash 继承来的
  // 工程根路径），导致相对路径被解析到 client root 之外。删掉，让 p4 用真实 cwd。
  delete env.PWD;
  delete env.OLDPWD;

  return {
    ...env,
    // 指向本地沙箱：覆盖注册表里的 P4PORT
    P4PORT: `127.0.0.1:${identity.port}`,
    P4USER: identity.user,
    P4CLIENT: identity.client ?? DEFAULT_CLIENT,

    // 这一行才是挡住 .p4config 的关键：环境变量本身压不过配置文件（见文件头部的实测），
    // 让 p4 去找一个不可能存在的文件名，等于把"配置文件"这条来源整个关掉
    P4CONFIG: 'noconfig',
    // 覆盖本机全局的 P4IGNORE（注册表里可能指向别处的 ignore 文件），
    // 否则 add/reconcile 的结果会被外部规则悄悄过滤掉
    P4IGNORE: P4IGNORE_FILE,

    // 兜底：测试过程中绝不允许弹出交互式工具
    // 编辑器：立即成功退出（不修改内容 = 接受原样提交）
    P4EDITOR: 'cmd.exe /c exit 0',
    // 合并工具：立即**失败**退出 —— 让冲突保持未解决，而不是被静默"解决"成错误内容
    P4MERGE: 'cmd.exe /c exit 1',
    // 差异工具：同样立即失败退出
    P4DIFF: 'cmd.exe /c exit 1',

    // 票据 / 配置源 / SSL 信任文件都关进实例目录，不碰用户的全局状态
    P4TICKETS: inst.tickets,
    P4ENVIRO: inst.enviro,
    P4TRUST: inst.trust,

    // 全工程统一 UTF-8（注册表里也是 utf8，这里显式声明）
    P4CHARSET: 'utf8',
  };
}

/** 打印用：当前沙箱身份的一句话描述 */
export function describeIdentity(identity: P4Identity, inst: InstancePaths): string {
  return [
    `实例      ${inst.name}`,
    `P4PORT    127.0.0.1:${identity.port}`,
    `P4USER    ${identity.user}`,
    `P4CLIENT  ${identity.client ?? DEFAULT_CLIENT}`,
    `服务器根  ${inst.root}`,
    `工作区根  ${inst.wsRoot}`,
  ].join('\n');
}
