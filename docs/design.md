# 设计说明

## 这个工程解决什么问题

需要一个能**反复折腾**的 Perforce 环境：随便提交、随便删、随便搞坏，然后用一条命令回到干净基线。
但不能依赖任何远程服务器 —— 开发机的全局 Perforce 配置往往指向组织内的一台真实服务器，任何一次误连都不可接受。

所以本工程的核心是两件事：**本地自包含**（p4d 就跑在 `.sandbox/` 里）和**隔离防护**（哪怕环境被搞脏也连不到生产）。

### 非目标

- 不做 P4V / Helix Swarm / 副本（replica）等周边组件的模拟
- 不做性能压测（免费版 p4d 有用户数与工作区数上限）
- 不替代对真实服务器行为的验证 —— 沙箱证明的是**机制**，不是**生产配置**

## 目录结构

```
test-p4/
├─ .p4config              # 手工敲 p4 时自动指向本地沙箱（防误连的第一道便利设施）
├─ .p4ignore              # 空文件，覆盖本机全局的 P4IGNORE
├─ src/                   # 沙箱实现（对外 API 见 src/index.ts）
│  ├─ paths.ts            #   路径解析 + p4d/p4 可执行文件探测
│  ├─ env.ts              #   隔离环境构造 + 参数拦截    ← 安全核心
│  ├─ exec.ts             #   p4 子进程封装（P4Cli）
│  ├─ parse.ts            #   -ztag 输出解析与表单字段读写
│  ├─ p4d.ts              #   p4d 生命周期（启动/就绪/停止/模板快照）
│  ├─ seed.ts             #   标准夹具：depot / 用户 / 工作区 / 提交历史
│  ├─ timing.ts           #   可选的耗时观测（P4_SANDBOX_TIMING=1）
│  └─ sandbox.ts          #   门面 Sandbox + 被测工具句柄 + 隔离自检
├─ scripts/
│  ├─ sandbox.ts          # 管理 CLI（up/down/status/reset/snapshot/clean）
│  ├─ fetch-p4d.ts        # 可选：下载官方 p4d.exe / p4.exe 到 vendor/
│  └─ probe-specs.ts      # 开发辅助：dump 服务器默认 spec 结构
├─ test/
│  ├─ fixtures.ts         # Vitest 夹具：每个测试文件一个独立实例
│  ├─ global-setup.ts     # 只跑一次：生成基线模板
│  ├─ helpers.ts          # 断言与文件辅助
│  ├─ basic/              # 基础工作流机制
│  ├─ destructive/        # 破坏性实验与重置（一条 reset 语义一个文件）
│  ├─ integration/        # 被测工具接入
│  ├─ isolation.test.ts   # 隔离防护的负向验证
│  └─ isolation-env-precedence.test.ts   # 环境变量优先级（不用夹具，见"性能"）
├─ examples/under-test/   # 「被测工具」样例
└─ .sandbox/              # [gitignore] 运行时数据，可整体删除
   ├─ template/           #   seed 后的服务器快照（秒级重置的来源）
   ├─ template-clients.json # 模板里 client 表单原文的缓存（省 3 次 p4 往返）
   ├─ empty/              #   "空 Unicode 库"骨架（省掉现场跑 p4d -xi 的约 250ms）
   ├─ server/             #   常驻沙箱的 p4d root
   ├─ instances/          #   测试用的一次性实例
   ├─ ws/                 #   client 工作区
   └─ sandbox.json        #   常驻沙箱状态
```

**一切运行时数据都在 `.sandbox/` 下**，删除即回到"未初始化"状态，不会污染系统其他位置。

## 隔离防护（安全核心）

开发机的全局 Perforce 配置里常常有一份指向真实服务器的设置 —— 注册表
`HKCU\Software\Perforce\Environment`、`~/.p4enviro`，或某层父目录下的 `.p4config`。
它的服务器地址与用户名**与本仓库无关，本仓库也不记录**：下面四层的判据全部是白名单式的，
换一台机器、换一个服务器地址，防护强度都不变。代码或文档里出现任何具体域名，都是这种设计意图被误读的信号。

危险在于：在沙箱目录之外裸跑一次 `p4`，读到的就是那份配置。所以沿着 p4 的配置来源链做了四层防护。

实测得到的优先级顺序是：**命令行 > `P4CONFIG` 文件 > 环境变量 > 注册表**。
三条都实测过：环境变量指向 9 就连 9；同样的环境变量放进含 `.p4config`（写着 8）的目录后会连 **8**；
再加上命令行的 `-p`，连的又是命令行指定的那个。

### 第一层：命令行硬指定

`P4Cli.run()` 无条件在参数最前面追加 `-p 127.0.0.1:<port> -u sandbox`（`src/exec.ts`）。
命令行是 p4 的最高优先级来源，压过一切配置文件与注册表；重复的全局选项里**第一个生效**（实测）。

### 第二层：环境变量覆盖

`buildP4Env()`（`src/env.ts`）先**大小写不敏感地删除继承来的全部 `P4*` 变量**，再写入沙箱值。
不能只做覆盖 —— 任何没被覆盖到的变量都会原样泄漏给子进程。

```ts
P4PORT     127.0.0.1:<port>     // 覆盖机器级配置的指向
P4USER     sandbox
P4CLIENT   sandbox_main
P4CONFIG   noconfig             // 关掉"配置文件"这条来源，见下方说明
P4IGNORE   <工程内空文件>        // 覆盖本机全局的 ignore 规则
P4TICKETS  <实例目录>/.p4tickets // 票据隔离
P4ENVIRO   <实例目录>/.p4enviro  // 配置源隔离
P4TRUST    <实例目录>/.p4trust   // SSL 信任库隔离
P4EDITOR   cmd.exe /c exit 0    // 避免测试中弹出编辑器
P4MERGE    cmd.exe /c exit 1    // 拒绝交互式合并
P4DIFF     cmd.exe /c exit 1    // 拒绝交互式比较
P4CHARSET  utf8                 // 唯一值得保留的全局值
```

**`P4CONFIG=noconfig` 才是挡住 `.p4config` 的那一手** —— 别把它换成"反正环境变量会兜底"，
兜不住：实测环境变量**压不过** `P4CONFIG` 文件。让 p4 去找一个不可能存在的文件名，
等于把这条来源整个关掉。

另外删掉 `PWD` / `OLDPWD`：**p4 用 `$PWD` 判断"当前目录"，它会盖过子进程的真实 cwd**
（实测从 Git Bash 调用时会让所有相对路径解析到错误的目录）。

### 第三层：参数层拒绝

`assertSandboxOwnsGlobalOptions()`（`src/env.ts`）要求调用方的参数**从命令名开始** ——
也就是不接受调用方传入任何全局选项。

p4 只把**命令之前**的选项当作全局选项（实测：`p4 info -p x:1` 报 `Usage: info [-s]`，
而 `p4 -p x:1 info` 会真的去连 x:1）。全局选项是唯一能改变连接目标的东西，而沙箱已经在参数
最前面注入了自己的 `-p` / `-u` / `-c`，所以调用方再传只会与注入的争抢，造成覆盖或歧义。

这条判据**只看位置、不看值**，因此不依赖 p4 的选项表：`-p 127.0.0.1:9`、`--port=…`、
`-u someone-else`、`-x args.txt`（从文件读参数 —— 文件内容由调用方控制）全都一并拦下，
将来 p4 新增任何全局选项也逃不掉。反过来，检查"值长什么样"是守不住的：
值的形态无穷无尽，位置却只有两种。

### 第四层：连接后自检

`Sandbox.assertIsolated()` 在每次启动/重置后执行，判据只有一条：
`p4 info` 里服务器**自己报出**的 `serverRoot` 必须等于本实例的 root 目录。

这是**充分**判据：连到任何别的服务器，这个路径都不可能相同。所以这里不需要"已知服务器特征"
的黑名单 —— 那种写法只能挡住想得到的那些，还会让仓库里留下具体地址。

为什么不用 `Server address` 做主判据：p4d 会把它报成反向解析出来的主机名
（形如 `<主机>.<域>:<端口>`，实测如此），未必含 `127.0.0.1`，据此判断会误报。
`serverRoot` 是服务器自己报出的数据库目录，唯一且可信。

`test/isolation.test.ts` 对这几层做负向验证：自带全局选项被拒、环境里没有预期外的 `P4*` 变量、
缓存的就绪探测记录确实指向本实例、`serverRoot` 不匹配时自检抛错；
`test/isolation-env-precedence.test.ts` 单独验"环境变量压过注册表"那一条。

**性能注记**：自检不会额外多发一次 `p4 info` —— 就绪探测（`P4dServer.waitReady()`）本来就要
跑一次 `p4 info`，它把 `-z tag` 解析出的记录留在 server 实例上（`lastInfo`），自检直接复用。
判据本身一字未改，改的只是"每次自检都现查"→"启动时查一次"。缓存挂在 `P4dServer` 实例上，
而 `reset()` 会换一个新的 server 实例，所以缓存不会过期；`Sandbox.attach()` 从未跑过就绪探测
（`lastInfo` 为 undefined），自检会退回现查。`test/isolation.test.ts` 里有一条用例专门确认
缓存的记录确实指向本实例 —— 否则"省掉一次查询"就会悄悄变成"跳过一次校验"。

### 防护边界（不能防什么）

- 只保护**通过本工程 API 发起**的调用。在工程目录之外手敲 `p4` 不受保护 —— 这正是
  `.p4config` 与"先 `p4 info` 确认 Server root"这两个习惯存在的原因。
- 回环地址白名单**不等于**安全：回环端口上可能坐着一条通往远程的隧道。这正是不省掉
  第四层 `serverRoot` 比对的原因。
- 不防主动攻击者 —— 能连上回环端口的本地进程可以伪造 `p4 info` 的响应。它防的是**误连**。

### 禁止事项

- **任何代码不得调用 `p4 set`** —— 它会写注册表，污染的是整台机器而不只是本工程
- **不得读写 `HKCU\Software\Perforce`**
- **不得裸启动 p4d**（不加 `-r` / `-p`）—— 会占用默认端口 1666 并在当前目录建库

## p4d 生命周期

`P4dServer`（`src/p4d.ts`）负责启动、就绪探测与停止。

**启动**：`-r <root> -p 127.0.0.1:<port> -J <journal> -L <log> -q --pid-file=<file>`，
以 `detached: true` + `unref()` 起后台进程。不用 `-d` —— 它在 Windows 上语义不一致，
由 Node 自己管理后台进程更可控。

**就绪**：轮询 `p4 info -s`（短输出，响应快），失败时读日志尾部作为诊断信息抛出。

**停止**：默认走 `p4 admin stop`（会干净收尾 journal），超时后按 pid 文件 `taskkill /T /F`。
但**p4d 收尾本身要花约 950ms** —— 这是重置路径上最大的一笔开销，远超"少起几次 p4 子进程"
能省下的量。所以 `reset()` / `dispose()` 用 `stop({ force: true })` 直接强杀：它们紧接着
就会覆盖或删除整个数据库，那份干净 journal 没有任何保留价值。需要保留数据的调用方
（`ensureTemplate` 的快照、`sandbox:down`）才走默认路径。

> ⚠️ **强杀之后必须删掉 journal。** journal 位于 root **外面**（见 `instancePaths()`），
> 不会被模板复制覆盖；残留下来会在下次启动时被 p4d 重放到新数据库上 —— 等于把刚重置掉的
> 内容又变回来。`reset()` 里显式 `rmrf(inst.journal)`。删掉后 p4d 会新建一份，与"实例首次
> 启动"的状态完全一致（该状态本来就由既有用例证明可行：新实例目录里从来没有 journal）。

**Unicode**：`P4CHARSET=utf8` 要求服务器处于 Unicode 模式，
全新目录需要先跑一次 `p4d -r <root> -xi` 初始化（输出 `Server switched to Unicode mode.`），
否则客户端会报 `Unicode clients require a unicode enabled server.`。

**端口**：测试实例用 `net.createServer().listen(0)` 取空闲端口；常驻沙箱固定 1666（方便 P4V 连），
被占用时自动改用其他端口并在输出里告知。

## 模板与重置

`ensureTemplate()` 用一个临时实例跑完整 seed，停掉 p4d 后把**数据库目录**复制成 `.sandbox/template/`。
之后所有实例都从它复制，重置就是"强杀 → 删 root/journal → 复制模板 → 重启 → 重定向 client → `sync -f`"，
实测约 0.5 秒（原先是 1.7 秒，差在不再等 p4d 做那约 950ms 的干净收尾）。

journal / log / pid / 票据文件刻意放在 root **外面**（见 `instancePaths()`），
保证模板永远是干净的纯数据库。

模板还有一份 sidecar：`.sandbox/template-clients.json`，存着模板里 client 表单的**原文**
（`p4 client -o` 的输出）连同模板指纹（`db.domain` 的大小 + mtime）。实例侧于是只做一次
`client -i` 就能把 Root 指回自己，省掉"列出 client + 每个 client 读一次表单"这 3 次 p4 往返。
sidecar 缺失或指纹不符时 `ensureTemplate()` 会重建整份模板（自愈，不需要手工删目录），
而 `#retargetClients()` 会退回读-改-写。

> ⚠️ 表单原文**必须**来自服务器。不要用 `seed.ts` 的 `clientForm()` 本地重拼去"省"这次读取 ——
> p4d 存 spec 时会做规范化（实测 `Options` 会多出 seed 没写的 `noaltsync`），自拼的表单会把
> 未列出的字段悄悄改回默认值，而且这种错误在测试里完全静默。

### 复制模板后必须做的两件事

1. **重定向 client spec**：模板里的 client `Root` 记的是模板实例的绝对路径，
   复制后必须改回本实例（`Sandbox.#retargetClients()`），否则 p4 会把文件同步到早已被删除的目录。
   优先走 sidecar 快路径（2 次往返），缓存不可用时退回读-改-写（5 次）。
2. **`sync -f`**：模板的 have list 声称文件已同步，普通 `sync` 会认为无事可做，
   而磁盘上其实什么都没有（`Sandbox.#syncWorkspace()`）。

注意 `reset({ hard: true })` **两件事都不需要**：`seedSandbox()` 刚用本实例的路径建好 client、
并自己 sync 过，所以那里传 `#prepareWorkspace({ retarget: false, sync: false })`。

`reset({ hard: true })` 跳过模板，删干净后重新 seed —— 修改夹具定义（`src/seed.ts`）之后必须用它，
或跑 `pnpm sandbox:snapshot` 重新生成模板。

## 标准夹具

`src/seed.ts` 从空库建出：

- 1 个 depot：`//depot/main`（local 类型）
- 2 个工作区：`sandbox_main`（完整映射）、`sandbox_src`（只映射 `//depot/main/src/...`，用于验证部分映射与工作区隔离）
- 4 步提交历史：初始导入（5 个文件）→ 修改 → 删除 → 新增（含中文文件名与 4 层深目录）
- 文件类型覆盖文本、二进制（`bin/data.bin`）、中文文件名、深层目录

夹具刻意覆盖这几类容易出问题的场景。可选开关：`includeTypemap`（含 `+S` 独占签出规则）、
自定义 `clients` / `history` / `depots`。

## p4 输出封装

`P4Cli.run()` 默认 `-z tag`（`... key value` 行）并解析成 `Record<string, string>[]`，
同键重复出现即视为多条记录（`src/parse.ts`）。

需要**区分输出级别**时用 `-s`：p4 给每行加 `error/warning/info/text/exit` 前缀，
比解析 stderr 可靠。`-s` 与 `-z tag` 互斥（前缀会破坏 tag 行），构造时会直接报错。

非 0 退出抛 `P4Error`，携带完整命令行与 stdout/stderr；断言"该失败的操作确实失败了"时传 `allowFailure: true`。

表单类命令（`user -i` / `client -i` / `typemap -i`）用 `input` 传 stdin，
配合 `parse.ts` 的 `getFormField` / `setFormField` 做字段级读写。

## 测试组织

**隔离粒度是"文件"而不是"用例"**（`test/fixtures.ts`，`scope: 'file'`）：
每个测试文件从模板复制一份独立实例（独立 root、独立端口、独立工作区），文件之间可以安全并行；
同一文件内的用例共享实例，能把它们串成一个完整故事（先提交、再回退、再校验）。

**会改动实例状态的用例应当独占一个文件。** 理由见"性能"一节：每个文件本来就是从模板复制出的
干净基线，独占文件等于免费得到一次重置，而文件之间是并行的；反过来，把多个破坏性用例塞进
一个文件、再在每个开头 `reset()` 一次，会让它们退化成串行。`test/destructive/` 下每个文件
对应一条 reset 语义，就是这么切的。

`reset()` 在同文件内只用于两种情况：验证 reset 行为本身，或用例确实要回到中途某个基线。

`globalSetup` 负责生成模板，只跑一次 —— 否则多个测试文件并行启动会同时去 seed 同一份模板。

调试时设 `P4_KEEP_SANDBOX=1` 跳过清理，并打印出端口与工作区路径，可直接用 P4V 连上去看现场。
注意此时**每个测试文件各留一个实例**，看完记得 `pnpm sandbox:clean`。

## 性能：瓶颈在哪、怎么测

沙箱的性能瓶颈是**「p4.exe 子进程往返次数」×「串行次数」**，不是文件 IO、不是网络、
也不是夹具规模（夹具只有 7 个几字节的文件，`sync -f` 的传输开销可以忽略）。
本机实测标定：

| 操作 | 耗时 |
|---|---|
| `p4.exe` 纯启动（不连服务器） | ~80ms |
| 连活服务器的 p4 往返 | ~50-100ms |
| **失败**的 p4 调用（连关闭端口） | **~2.1s**（p4 客户端内部重试；OS 层其实是立即 ECONNREFUSED，Node 实测 0-1ms） |
| 连"活着但不是 p4"的监听端口 | >8s（p4 一直等握手，比死端口还慢一个数量级） |
| p4d 干净收尾（`p4 admin stop` → 进程真的退出） | **~950ms** |
| 模板复制（1.7MB / 109 文件） | ~50ms |

四条由此得出的结论：

1. **p4d 的干净收尾是最大的一笔开销**，远超"少起几个 p4 子进程"。重置路径上改用强杀（见上）。
2. **别把破坏性用例塞进同一个文件**：它们会退化成串行。拆分前一个文件就吃掉了整套测试 97% 的墙钟。
3. **失败的探测比成功的贵 20 倍。** 所以 `waitReady` 的首次探测必须打在一个已经在监听的端口上。
   实测首次探测确实能打中（约 50ms），因此**没有**引入额外的 TCP 预探；将来一旦发现
   `wait-ready` 异常变大，第一个要查的就是这里。
4. **死端口那 2.1s 调不小**：`p4 help environment` 里没有任何超时或 net 相关变量，`net.*`
   全是服务端 configurable，而本仓库禁止 `p4 set`（写注册表）。能做的只是把它挪出关键路径
   —— 这就是 `test/isolation-env-precedence.test.ts` 单独成文件、且不用夹具的原因。

看实测数据（按需开启，只往 stderr 写一行汇总，不影响测试输出）：

```powershell
P4_SANDBOX_TIMING=1 pnpm test
# [timing] reset sbx-… total=486ms | stop=145ms fs=113ms … | p4-spawns=4
```

**`p4-spawns` 才是这套东西的真正货币** —— 只要它没降，墙钟变快就多半是抖动。
各阶段的预期往返数：`start` = 4（就绪探测 1 + 重定向 2 + sync 1；自检复用就绪探测的记录，所以是 0），
软 `reset` = 4，硬 `reset` = 15（其中 seed 约 13）。

`P4_SANDBOX_TIMING` 会被 `buildP4Env()` 从子进程环境里清掉（它大小写不敏感地删掉所有 `P4*`），
所以这个开关不会泄漏给 p4 或被测工具 —— 这是刻意的，计时状态只属于父进程。也正因如此，
**不要**把它加进 `buildP4Env` 的输出，否则 `test/isolation.test.ts` 的白名单断言会红。

## 踩过的坑（实测记录）

这些是搭这套东西时真实撞到的问题，写在这里免得以后重新踩：

| 现象 | 原因 | 解法 |
|---|---|---|
| `p4 add -c sandbox_src` 报错 | 命令**之后**的 `-c` 是 changelist，全局位置的 `-c` 才是 client | `RunP4Options.client` 注入到全局位置 |
| `Path ... is not under client's root` | p4 用 `$PWD` 判断当前目录，盖过了子进程真实 cwd | 删 `PWD`/`OLDPWD` + 传 `-d` |
| `p4 info` 输出为空 | `-q` 把 info 级消息一起抑制了 | 需要输出时不加 `-q`；`waitReady` 因此改用 `-z tag`，顺带把记录留给自检复用 |
| 强杀 p4d 之后重置"失效" | 残留 journal 位于 root 之外，不会被模板复制覆盖，下次启动被重放到新数据库 | `reset()` 里显式 `rmrf(inst.journal)` |
| client spec 字段被悄悄改回默认值 | 本地重拼的表单缺少 p4d 规范化后新增的字段（实测 `Options` 多出 `noaltsync`） | 表单原文一律取自 `p4 client -o` 的产出，不自己拼 |
| `Unknown field name 'Description'` | user spec 没有这个字段 | 去掉 |
| typemap 写不进去 | 字段名是 `TypeMap` 不是 `Typemap` | 用 `p4 typemap -o` 确认 |
| `p4 clients -u sandbox` 查不到工作区 | client spec 的 `Owner` 为空（表单里没显式写） | 表单显式写 `Owner:`，查询也不加 `-u` |
| `submit -c N -d "..."` 报 Usage | 两个选项互斥 | 只保留 `-c`（实测 `submit -c` 不打开编辑器） |
| `Unicode clients require a unicode enabled server` | 服务器不是 Unicode 模式 | 空目录先跑 `p4d -xi` |
| 工作区文件内容对不上断言 | client 的 `LineEnd: local` 使文件是 CRLF | 断言前规范化 `\r\n` → `\n` |
| 删 `.sandbox` 偶尔失败 | Windows 文件锁延迟释放 | 删除带重试 |
| `p4 where` 对未映射路径返回 0 | 它只发 warning，不是 error | 用 `-s` 断言 `warning:` 前缀，别断言退出码 |
| `p4 sync -n` 什么都不报 | 本地删文件不改变 have rev，预演认为"无事可做" | 用 `sync -n -f` |
