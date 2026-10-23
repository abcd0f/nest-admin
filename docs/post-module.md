# 岗位模块（Post）

对齐 RuoYi-Vue-Plus 的 `SysPostController` / `SysPostServiceImpl`，把 `sys_post` 从"只有表"变成可用模块，并接入用户岗位分配与数据范围。

## 1. 与 Java 的结构差异

| 项 | RuoYi-Vue-Plus | 本项目 | 处理 |
| --- | --- | --- | --- |
| 部门归属 | `dept_id bigint NOT NULL` | 原模型无此列 | **新增 `dept_id`**，可空（兼容历史行），接口层强制必填 |
| 岗位类别 | `post_category` | 无 | 未实现，需要时再加列 |
| 排序字段 | `post_sort` | `order_num` | 沿用本项目命名，与菜单/角色/部门一致 |
| 删除 | **物理删除**（`sys_post` 无 `del_flag`） | 逻辑删除 `del_flag='2'` | 与 user/role/dept 保持一致 |
| 岗位名称唯一性 | `(post_name, dept_id)` 内唯一 | 同左 | 已对齐 |
| 岗位编码唯一性 | 全局唯一 | 同左 | 已对齐 |
| 停用保护 | 有用户在用则禁止停用 | 同左 | 已对齐 |
| 删除保护 | 有用户在用则禁止删除 | 同左 | 已对齐 |
| 登录上下文 | `LoginUser.posts` | 无 | 未加入 `AuthenticatedUser`，目前没有消费方 |

新增 `dept_id` 的原因不是"为了跟 Java 一样"，而是三个功能都依赖它：岗位列表按部门过滤、岗位名称在部门内唯一、数据范围按部门收敛。没有这一列，岗位只能全局可见，和刚补完的数据权限体系不自洽。

## 2. 接口

| 方法 | 路径 | 权限码 | 说明 |
| --- | --- | --- | --- |
| GET | `/system/post/list` | `system:post:list` | 分页；支持 `postCode`/`postName` 包含、`status`、`deptId` 精确；受数据范围约束 |
| GET | `/system/post/optionselect` | `system:post:query` | 下拉：仅启用岗位，可选 `?deptId=`；受数据范围约束 |
| GET | `/system/post/:id` | `system:post:query` | 详情；范围外返回 404 |
| POST | `/system/post` | `system:post:add` | 创建；目标部门必须在范围内，否则 403 |
| PUT | `/system/post/:id` | `system:post:edit` | 更新；换部门同样校验范围；已分配用户不能停用 |
| DELETE | `/system/post/:id` | `system:post:delete` | 逻辑删除；已分配用户不能删除 |

`optionselect` 必须声明在 `:id` 之前，否则会被当成 ID 解析。路径名对齐 Java 的 `/system/post/optionselect`。

## 3. 用户岗位分配

对齐 Java 的 `SysUserBo.postIds`——岗位不单独开分配接口，随用户创建/更新一起提交：

```http
POST /system/user
{ "userName": "alice", "nickName": "Alice", "password": "...", "postIds": ["5", "6"] }

PUT /system/user/9
{ "postIds": [] }        // 空数组 = 清空；字段省略 = 不改动
```

- 事务内校验岗位存在、启用、未删除，任一不满足整笔回滚（422）。
- 写入方式为"完整替换"：先 `deleteMany` 再 `createMany`，重复 ID 去重。
- 用户列表/详情/创建/更新/分配角色的响应都带 `postIds`。
- 删除用户时一并清理 `sys_user_post`。

与角色的差别：角色有独立的 `PUT /system/user/authRole/:id` 端点和 `system:user:assignRoles` 权限；岗位没有独立端点，编辑用户即可改岗位，权限沿用 `system:user:edit`。

## 4. 数据范围

岗位的归属列是 `{ dept: 'deptId', owner: 'createBy' }`，与 Java `SysPostMapper` 的 `@DataColumn(dept_id, create_by)` 一致。

`dept_id` 允许为空带来的行为：历史行（`dept_id IS NULL`）对受限用户不可见，对"全部数据"范围的管理员可见——这是失败关闭，不是漏过滤。

## 5. 迁移

```sql
-- prisma/migrations/20261023093500_add_post_dept/migration.sql
ALTER TABLE "sys_post" ADD COLUMN "dept_id" BIGINT;
```

执行：`pnpm db:migrate`（开发）/ `pnpm db:deploy`（生产）。

注意 `prisma/migrations` 被 `.gitignore` 忽略，迁移文件不会入库，需要另行同步。

## 6. 验证

```
npx vitest run apps/gateway/src/modules/system/system-management.spec.ts  → 41 passed
npx vitest run                                                           → 354 passed
npx nest build gateway                                                   → 通过
npx eslint "apps/gateway/src/modules/system/**/*.ts"                      → 0 error
```

新增用例覆盖：分页过滤与范围条件、编码/名称唯一性冲突、已分配用户时禁止停用和删除、逻辑删除标记、创建用户时写岗位关联、引用无效岗位回滚、下拉只返回启用岗位。

全量测试里 `libs/logger/src/logger.transport.spec.ts` 仍失败，是 Windows 文件系统语义问题（`mkdir` 返回 `ENOTDIR`），与本改动无关。
