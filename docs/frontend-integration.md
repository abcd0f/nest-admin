# 前端对接：ruoyi-plus-vben5 → nest-admin

把 `ruoyi-plus-vben5-main`（Vben 5 + Ant Design Vue + alova）接到 nest-admin 上，不做多租户。

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 对接方向 | **改前端适配后端**，后端只放开一个字段 |
| 已打通 | 登录、动态路由、用户 / 角色 / 菜单 / 部门 / 岗位 五个页面的增删改查 |
| 未打通 | 字典页、参数、公告、OSS、租户、监控、代码生成、工作流、导入导出、角色分配用户 |
| 验证状态 | **未跑**：前端没有 `node_modules`，无法 typecheck / dev |

为什么改前端而不是改后端：后端的响应封装（`{code:0,data,message}`、`{items,meta}`）刚按 Java 语义定稿并有测试覆盖，改它等于推翻全部测试；前端是客户端，差异集中在 `src/api` 一层，改一处收口。

## 2. 契约差异与处理

| 项 | RuoYi-Vue-Plus | nest-admin | 处理位置 |
| --- | --- | --- | --- |
| 业务成功码 | `200` | `0` | `packages/constants/src/core.ts` |
| 消息字段 | `msg` | `message` | `utils/http/index.ts`（两个都认） |
| 分页响应 | `{ rows, total }` | `{ items, meta: { total } }` | `api/nest-adapter.ts` → `toPageResult` |
| 分页参数 | `pageNum` | `page` | `toPageQuery` |
| 更新 | `PUT /system/user`（id 在 body） | `PUT /system/user/:id` | 各 API 层把 id 拆到路径 |
| 删除 | `DELETE /{ids}` 批量 | `DELETE /:id` 单条 | `removeEach` 循环调用 |
| 登录 | `{username,password,tenantId,clientId}` → `{access_token}` | `{userName,password}` → `{accessToken}` | `api/core/auth.ts` |
| 用户信息 | `GET /system/user/getInfo` → `{user,roles,permissions}` | `GET /auth/profile` 扁平结构 | `api/core/user.ts` |
| 路由菜单 | `GET /system/menu/getRouters` → `RouterVo[]` | `GET /auth/menus` → 菜单树 | `api/core/menu.ts` → `toRouterMenu` |
| 用户字段 | `phonenumber` | `phoneNumber` | `api/system/user` |
| 角色排序 | `roleSort` | `orderNum` | `api/system/role` |
| 岗位排序 | `postSort` | `orderNum` | `api/system/post` |
| 部门负责人 | `leader` | `leaderId` | `api/system/dept` |
| 菜单列表 | 扁平数组 | 树 | `flattenTree` |
| 字典 | `GET /system/dict/data/type/{type}` | 无接口 | 前端内置 5 张常用字典 |

## 3. 改动清单

前端（`ruoyi-plus-vben5-main`）：

| 文件 | 改动 |
| --- | --- |
| `packages/constants/src/core.ts` | `BUSINESS_SUCCESS_CODE` 200 → 0 |
| `apps/web-antd/src/utils/http/index.ts` | 消息字段兼容 `message` |
| `apps/web-antd/src/api/nest-adapter.ts` | **新增**：分页、拍平、批量删除、字段裁剪 |
| `apps/web-antd/src/api/core/auth.ts` | 登录入参/出参转换；租户列表返回"未启用"；权限码空实现 |
| `apps/web-antd/src/api/core/user.ts` | `/auth/profile` → `{user, roles, permissions}` |
| `apps/web-antd/src/api/core/menu.ts` | 菜单树 → `RouterVo`（name/component/hidden/meta） |
| `apps/web-antd/src/api/system/user/index.ts` | 路径、分页、`PUT /:id`、角色二次分配、详情补角色/岗位选项 |
| `apps/web-antd/src/api/system/role/index.ts` | 同上 + `menuIds` 走 `PUT /role/menus/:id`、`deptTree`/`dataScope` 路径 |
| `apps/web-antd/src/api/system/menu/index.ts` | 列表拍平、角色菜单回显走 `/system/role/menuTree/:id` |
| `apps/web-antd/src/api/system/dept/index.ts` | 列表拍平、`exclude` 本地计算 |
| `apps/web-antd/src/api/system/post/index.ts` | `postSort` ↔ `orderNum`、部门树复用 `/system/dept/list` |
| `apps/web-antd/src/api/system/dict/dict-data.ts` | 内置 `sys_normal_disable` 等 5 张字典 |
| `apps/web-antd/vite.config.ts` | 代理指向 `http://localhost:3000`，**去掉 `/api` 重写** |
| `apps/web-antd/.env.development` | 关闭请求加密与 SSE |

后端（`nest-admin`）：

| 文件 | 改动 |
| --- | --- |
| `post/dto/post.dto.ts` | `deptId` 改为可选 |
| `post/post.service.ts` | 省略时回落到 `actor.deptId`，仍做范围校验 |

改后端这一处的原因：前端岗位表单没有部门字段（左侧部门树只做筛选），必填会直接 422。

## 4. 启动

```bash
# 后端
cd E:/test/nest-vben-admin/nest-admin
pnpm db:migrate          # 含 add_post_dept
psql ... -f prisma/seed/ruoyi-rbac-seed.sql
pnpm start:dev           # http://localhost:3000/api

# 前端
cd E:/test/nest-vben-admin/ruoyi-plus-vben5-main
pnpm install
pnpm dev                 # http://localhost:5666
```

账号：`admin / admin123`。

代理已改成 `/api` → `http://localhost:3000` 且**不重写**，因为后端的全局前缀就是 `api`。

## 5. 未打通的部分

这些页面的接口在后端不存在，点进去会 404 或空数据：

- 字典管理 / 参数设置 / 通知公告 / 文件管理 / 客户端管理
- 系统监控（在线用户、缓存）、系统工具（代码生成）、租户管理
- 工作流、演示模块
- 用户导入导出、岗位导出、角色导出
- 角色「分配用户」（`/system/role/authUser/*` 未实现）
- 菜单级联删除（后端只能逐个删，有子节点会被拒）

## 6. 未验证

前端 `node_modules` 未安装（安装被中止），所以**没有跑 typecheck、lint、dev 启动**。改动是静态代码调整，类型上做了保守处理（跨模块统一用 `any` 承接后端原始行再映射），但首次 `pnpm install && pnpm dev` 仍可能出现类型或运行时问题，需要实际跑一遍确认。
