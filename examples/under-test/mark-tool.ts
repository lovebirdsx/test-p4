/**
 * 模拟一个"自研工具"：给工作区里的文件追加一行标记并提交。
 *
 * 它刻意**不接受任何服务器地址参数** —— 完全依赖运行环境里的
 * P4PORT / P4USER / P4CLIENT。这正是被测工具接入沙箱的方式：
 * 工具代码零改动，由沙箱负责把环境注入进来。
 *
 * 用法：node examples/under-test/mark-tool.ts <工作区相对路径> <标记文本>
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [relPath, marker] = process.argv.slice(2);

if (!relPath || !marker) {
  console.error('用法：node examples/under-test/mark-tool.ts <工作区相对路径> <标记文本>');
  process.exit(2);
}

function p4(args: readonly string[]): string {
  return execFileSync('p4', [...args], { encoding: 'utf8' });
}

// 把工具"看到的世界"打出来，便于用例断言它确实连到了沙箱
console.log(`[tool] P4PORT=${process.env.P4PORT ?? '(未设置)'}`);
console.log(`[tool] P4USER=${process.env.P4USER ?? '(未设置)'}`);
console.log(`[tool] P4CLIENT=${process.env.P4CLIENT ?? '(未设置)'}`);
console.log(`[tool] cwd=${process.cwd()}`);

p4(['edit', relPath]);
appendFileSync(relPath, `${marker}\n`);
const output = p4(['submit', '-d', `自动标记：${marker}`]);
console.log(output.trim());
console.log(`[tool] 已标记 ${relPath}`);
