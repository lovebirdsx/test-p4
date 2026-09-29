# 手工实验手册

自动化测试之外，这套沙箱也可以当"随时可用的本地 Perforce"来手工折腾。

## 起一个常驻沙箱

```powershell
pnpm sandbox:up        # 首次会 seed 一份基线模板，约数秒
```

输出里会给出连接信息（端口、用户、工作区路径）。之后：

```powershell
pnpm sandbox:status    # 看看在不在跑、端口是多少、有没有残留实例
pnpm sandbox:down      # 停止（数据保留在 .sandbox/ 下）
```

## 在终端里敲 p4

**务必在工程目录（或它的子目录）里敲命令。** 工程根的 `.p4config` 会把 p4 指向本地沙箱：

```
P4PORT=127.0.0.1:1666
P4USER=sandbox
P4CLIENT=sandbox_main
```

```powershell
p4 info                      # Server root 应该指向 .sandbox\server
p4 changes -m 5 //depot/main/...
p4 opened
p4 sync
```

> ⚠️ **在工程目录之外敲 `p4` 会读到机器级的全局配置，直接连到那台真实服务器。**
> 本工程的防护（`src/env.ts` + `src/exec.ts`）只覆盖通过 Node API 发起的调用，
> 拦不住你在别的目录里手敲的命令。手工实验请养成"先 `p4 info` 确认 Server root"的习惯。

想看某个文件的当前状态：

```powershell
p4 fstat //depot/main/src/util.txt
p4 filelog -m 5 //depot/main/src/util.txt
```

## 用 P4V 连接

新建 Connection：

- **Server**：`127.0.0.1:1666`
- **User**：`sandbox`
- **Password**：留空（本地沙箱无 protections 表，空库时首个用户自动拥有 super 权限）

连上后浏览 `//depot/main/...`。工作区已经在 `.sandbox/ws/sandbox_main` 下同步好了。

> 注意 P4V 自己也有配置来源，如果你的 P4V 里已经配了别的连接，新建 Connection 时别覆盖它。

## 快速重置

```powershell
pnpm sandbox:reset          # 从模板恢复，约 2 秒
pnpm sandbox:reset --hard   # 丢弃模板重新 seed，约数秒
```

区别：`reset` 是把数据库**复制回**模板状态（快）；`--hard` 是删干净**重新跑一遍 seed**（慢，但会应用 `src/seed.ts` 里的最新改动）。

任何破坏性实验之后都可以直接 `reset`，包括：

- 提交了一堆垃圾 changelist
- 删了 depot 里的文件、甚至 `p4 obliterate` 掉了历史
- 工作区被改得面目全非

重置会同时恢复**服务器数据**和**工作区文件**（重新同步 + 重定向 client Root）。

## 常见实验场景

### 看一个 changelist 的完整生命周期

```powershell
p4 change -o > cl.txt        # 拿一份表单模板
# 编辑 cl.txt，填 Description
p4 change -i < cl.txt        # 创建命名 changelist
p4 edit -c <CL> //depot/main/src/util.txt
# ...改文件...
p4 submit -c <CL>
p4 describe -s <CL>
```

### 制造并解决一次冲突

关键是**时序**：副工作区要先 `edit` 打开文件，主工作区再抢先提交，这样副工作区提交时才会撞上 out of date。
（如果副工作区在主工作区提交之后才 `sync`，它直接拿到最新版，根本不会冲突。）

```powershell
# 1) 副工作区先签出文件（此时两边都是 rev2）
p4 -c sandbox_src -d .sandbox\ws\sandbox_src sync
p4 -c sandbox_src -d .sandbox\ws\sandbox_src edit //depot/main/src/util.txt
#    用编辑器给文件加一行内容 —— p4 edit 之后它才变成可写的

# 2) 主工作区抢先提交同一个文件（产生 rev3）
p4 -c sandbox_main -d .sandbox\ws\sandbox_main edit //depot/main/src/util.txt
#    同样用编辑器改一下
p4 -c sandbox_main -d .sandbox\ws\sandbox_main submit -d "main 抢先提交"

# 3) 副工作区提交 → 被拒
p4 -c sandbox_src -d .sandbox\ws\sandbox_src submit -d "src 的改动"
#    //depot/main/src/util.txt - must resolve #3
#    Out of date files must be resolved or reverted.
#    注意：文件此时已经挂在**一个 pending changelist** 上了，记下它的号
p4 -c sandbox_src -d .sandbox\ws\sandbox_src changes -s pending -c sandbox_src

# 4) 同步并解决
p4 -c sandbox_src -d .sandbox\ws\sandbox_src sync
p4 -c sandbox_src -d .sandbox\ws\sandbox_src resolve -am
#    两边改到同一处时 -am 会报 "resolve skipped"，得显式选一边：
#      resolve -ay    用**我的**版本，丢弃库里的改动
#      resolve -at    用**库里的**版本，丢弃我的改动

# 5) 提交那个 pending changelist
p4 -c sandbox_src -d .sandbox\ws\sandbox_src submit -c <CL>
```

> `p4 -c <名字>` 在这里是**全局选项**（指定工作区），必须放在命令**之前**；
> 放到命令之后就成了 changelist 号。这是 p4 最容易踩的坑之一。
>
> 另外第 3 步被拒之后，别直接 `p4 submit -d "..."` —— 那只提交默认 changelist，
> 而文件在 pending changelist 里，会得到 "No files to submit from the default changelist"。

### 回退到历史版本

```powershell
p4 sync //depot/main/src/util.txt#2      # 同步到 rev2
p4 sync //depot/main/src/util.txt        # 再回到最新
p4 sync -f //depot/main/...              # 修复被本地删掉/改坏的文件
```

### 查证书 / 票据 / 配置来源

```powershell
p4 set                    # 看当前生效的配置（只读，不会写注册表）
p4 info                   # Server root 与 Server address
p4 login -s               # 看登录状态
```

`p4 set` **不带参数**是只读查询，安全；**不带参数以外的形式会写注册表**，本工程里禁止使用。

## 改夹具之后

`src/seed.ts` 定义了基线内容（depot、工作区、4 步提交历史、文件类型）。改完之后：

```powershell
pnpm sandbox:snapshot     # 重新生成模板（会自动停服务、重新 seed、再启动）
```

之后所有 `reset` 和新建的测试实例都会用新基线。
直接 `pnpm sandbox:reset --hard` 也可以，但那只影响当前这一个实例。

## 扩展夹具时查 spec 字段名

写 label / trigger / group / stream 这类表单前，先问服务器要一份默认结构：

```powershell
pnpm probe:specs                 # 全部
pnpm probe:specs label group     # 只看指定的几项
```

它会起一个临时沙箱，把 `p4 <spec> -o` 的原始输出打出来。
`src/seed.ts` 里"user spec 没有 Description 字段""typemap 的字段名是 TypeMap"这类事实就是这么确认的。

## 排查

```powershell
pnpm sandbox:status       # 状态 + 残留实例列表
pnpm sandbox:clean        # 结束残留的测试实例进程并清空 instances/
```

- **端口 1666 被占用**：`sandbox:up` 会自动改用空闲端口，实际端口看输出
- **p4d 进程残留**：`pnpm sandbox:clean`；实在不行 `tasklist | findstr p4d` 后手工 `taskkill`
- **服务器日志**：`.sandbox\server`（常驻）或 `.sandbox\instances\<名字>\`（测试实例）下的 `log.txt`
- **想保留测试现场**：`P4_KEEP_SANDBOX=1 pnpm test`，用例结束后不清理并打印端口，可直接用 P4V 连上去

## 全清重来

```powershell
pnpm sandbox:down
# 删掉 .sandbox/ 整个目录即可 —— 所有运行时数据都在里面
pnpm sandbox:up           # 会重新 seed 一份
```

`.sandbox/` 在 `.gitignore` 里，删除它不会影响仓库。
