/** Base64 编码格式，保留大小写不敏感匹配。 */
export const BASE64_PATTERN = /^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i;

/** Prisma 错误码：P 后跟四位数字。 */
export const PRISMA_ERROR_CODE_PATTERN = /^P\d{4}$/;

/** URL 主机名首尾的 IPv6 方括号，用于全局替换。 */
export const IPV6_HOST_BRACKETS_PATTERN = /^\[|\]$/g;

/** 年月日格式片段，用于日志日期断言。 */
export const LOG_DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;

/** 目录不可用时的文件系统错误码，用于日志初始化断言。 */
export const DIRECTORY_ERROR_PATTERN = /ENOTDIR|EEXIST/;

/** 字段密文版本前缀，用于加密结果断言。 */
export const FIELD_CIPHERTEXT_PREFIX_PATTERN = /^enc:v1:/;

/** Argon2id 哈希参数前缀，用于密码哈希结果断言。 */
export const ARGON2ID_HASH_PREFIX_PATTERN = /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/;

/** 日志脱敏测试中不应出现在输出里的敏感值。 */
export const LOGGER_TEST_SECRETS_PATTERN = /root-secret|nested-secret/;

/** HTTP 日志脱敏测试中不应出现在输出里的敏感值。 */
export const HTTP_LOG_TEST_SECRETS_PATTERN = /query-secret|header-secret|cookie-secret|body-secret|business-secret/;
