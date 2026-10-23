/**
 * 全仓正则常量。
 *
 * 只收"跨文件复用"或"表达业务规则"的模式；一次性的、耦合测试私有数据的正则留在调用点。
 * 带 `g` 标志的模式是有状态的（`lastIndex` 会被改写），只能用于 `String.replace`，
 * 不要拿去做 `test` / `exec`，否则第二次匹配会从上次位置继续。
 */

// ── 主键与关联 ID ────────────────────────────────────────────────

/**
 * BigInt 主键/外键的十进制字面量：正整数，最多 19 位。
 *
 * 位数上限与 int64 对齐，但 19 位里仍有超过 `9223372036854775807` 的值，
 * 数值上界由 `isBigIntId()` 再判一次，光靠正则拦不住。
 */
export const BIGINT_ID_PATTERN = /^[1-9]\d{0,18}$/;

/** 父节点 ID：在 {@link BIGINT_ID_PATTERN} 基础上允许 `0` 表示根节点。 */
export const PARENT_ID_PATTERN = /^(0|[1-9]\d{0,18})$/;

// ── 文本字段 ────────────────────────────────────────────────────

/** 必须包含至少一个非空白字符（昵称、名称类字段，允许前后有空格）。 */
export const CONTAINS_NON_WHITESPACE_PATTERN = /\S/;

/** 整串不含空白字符（岗位编码这类紧凑标识）。 */
export const NO_WHITESPACE_PATTERN = /^\S+$/;

/** 首尾必须是非空白字符，中间可含空白（账号，拒绝 `"  alice"` 这种存进去查不到的写法）。 */
export const TRIMMED_TEXT_PATTERN = /^\S(?:.*\S)?$/;

/**
 * 紧凑标识：不允许空白与 `*`。
 *
 * 用于角色标识 `roleKey` 与菜单权限码 `perms` —— 前者禁止通配符冒充角色，
 * 后者按 Sa-Token 语义单独处理通配，落库值本身不能带 `*`。
 */
export const IDENTIFIER_WITHOUT_WILDCARD_PATTERN = /^[^\s*]+$/;

// ── 认证令牌 ────────────────────────────────────────────────────

/** 会话 ID：UUID v4（`AuthSession` 的 key，也是 JWT 的 `sid` / `jti`）。 */
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 刷新令牌：`<uuid v4>.<43 位 base64url>`。 */
export const REFRESH_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[\w-]{43}$/;

/** 64 位小写十六进制摘要（SHA-256）。 */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

// ── 编码与哈希 ──────────────────────────────────────────────────

/** Base64 编码格式，保留大小写不敏感匹配。 */
export const BASE64_PATTERN = /^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i;

/** 字段密文版本前缀，用于加密结果断言。 */
export const FIELD_CIPHERTEXT_PREFIX_PATTERN = /^enc:v1:/;

/** Argon2id 哈希参数前缀，用于密码哈希结果断言。 */
export const ARGON2ID_HASH_PREFIX_PATTERN = /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/;

// ── 转义 ────────────────────────────────────────────────────────

/** 正则元字符，配合 `'\\$&'` 把任意字符串安全地拼进 `new RegExp()`。 */
export const REGEX_SPECIAL_CHARS_PATTERN = /[.*+?^${}()|[\]\\]/g;

/** Redis glob 元字符（`*`、`?`、`[]`、`\`），用于把前缀当字面量再拼通配符。 */
export const REDIS_GLOB_SPECIAL_CHARS_PATTERN = /[\\*?[\]]/g;

// ── 基础设施与日志 ──────────────────────────────────────────────

/** Prisma 错误码：P 后跟四位数字。 */
export const PRISMA_ERROR_CODE_PATTERN = /^P\d{4}$/;

/** URL 主机名首尾的 IPv6 方括号，用于全局替换。 */
export const IPV6_HOST_BRACKETS_PATTERN = /^\[|\]$/g;

/** 年月日格式片段，用于日志日期断言。 */
export const LOG_DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;

/** 目录不可用时的文件系统错误码，用于日志初始化断言。 */
export const DIRECTORY_ERROR_PATTERN = /ENOTDIR|EEXIST/;

// ── 测试断言用的敏感值 ──────────────────────────────────────────

/** 日志脱敏测试中不应出现在输出里的敏感值。 */
export const LOGGER_TEST_SECRETS_PATTERN = /root-secret|nested-secret/;

/** HTTP 日志脱敏测试中不应出现在输出里的敏感值。 */
export const HTTP_LOG_TEST_SECRETS_PATTERN =
  /query-secret|header-secret|cookie-secret|body-secret|business-secret/;
