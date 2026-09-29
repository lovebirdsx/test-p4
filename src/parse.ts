/**
 * p4 输出的解析与表单文本构造。
 *
 * 报告类命令（changes / fstat / opened / clients ...）统一用 `-z tag` 输出，
 * 每行形如 `... key value`；同一个 key 再次出现即视为下一条记录的开始
 * （与 P4Python 的启发式一致）。
 *
 * 表单类命令（client / depot / protect / typemap ...）不用解析回来的文本，
 * 而是由本工程按模板直接生成再经 `-i` 灌入 —— 模板生成比"读改写"更可控。
 */

/** `p4 -z tag` 输出的一条记录 */
export type P4Record = Record<string, string>;

/** 解析 `p4 -z tag` 输出为记录数组；非 tag 行（info 文本等）会被忽略 */
export function parseTaggedOutput(stdout: string): P4Record[] {
  const records: P4Record[] = [];
  let current: P4Record | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.startsWith('... ')) continue;
    const body = rawLine.slice(4);
    const sep = body.indexOf(' ');
    const key = sep === -1 ? body : body.slice(0, sep);
    const value = sep === -1 ? '' : body.slice(sep + 1);

    if (current && Object.hasOwn(current, key)) {
      records.push(current);
      current = undefined;
    }
    current ??= {};
    current[key] = value;
  }
  if (current) records.push(current);
  return records;
}

/** 取第一条记录（不存在则抛错，便于用例里直接断言） */
export function firstRecord(stdout: string, what = '命令'): P4Record {
  const records = parseTaggedOutput(stdout);
  const first = records[0];
  if (!first) throw new Error(`${what} 未返回任何记录。原始输出：\n${stdout}`);
  return first;
}

/** 按字段名取记录里的值（大小写不敏感，避免踩 p4 字段名大小写不一致的坑） */
export function field(record: P4Record, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** 取某个 key 的字符串数组（记录中每个 key 只会有一条，故合并所有记录） */
export function pluck(stdout: string, key: string): string[] {
  return parseTaggedOutput(stdout)
    .map((r) => r[key])
    .filter((v): v is string => v !== undefined);
}

/** 读表单里某个单行字段的值 */
export function getFormField(form: string, field: string): string | undefined {
  for (const line of form.split(/\r?\n/)) {
    if (line.startsWith(`${field}:`)) {
      return line.slice(field.length + 1).trim();
    }
  }
  return undefined;
}

/** 设置表单里某个单行字段的值（字段必须已存在于模板中） */
export function setFormField(form: string, field: string, value: string): string {
  const lines = form.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (index === -1) {
    throw new Error(`表单中不存在字段 ${field}，无法设置。表单内容：\n${form}`);
  }
  lines[index] = `${field}:\t${value}`;
  return lines.join('\n');
}

/** 把多行文本块缩进成 Perforce 表单要求的格式（每个续行以 tab 开头） */
export function indentFormBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? '\t' : `\t${line}`))
    .join('\n');
}
