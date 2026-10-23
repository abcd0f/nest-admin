# RBAC 架构设计文档

> **文档作者**: 企业级高级系统架构师  
> **创建日期**: 2026-10-23  
> **目标**: 从零重构企业级 RBAC 权限系统的完整架构方案

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [当前系统分析](#2-当前系统分析)
3. [RBAC 核心概念与企业级要求](#3-rbac-核心概念与企业级要求)
4. [架构设计原则](#4-架构设计原则)
5. [数据模型设计](#5-数据模型设计)
6. [认证模块架构](#6-认证模块架构)
7. [授权模块架构](#7-授权模块架构)
8. [数据权限（Data Scope）架构](#8-数据权限data-scope架构)
9. [菜单权限架构](#9-菜单权限架构)
10. [会话管理架构](#10-会话管理架构)
11. [性能优化策略](#11-性能优化策略)
12. [安全加固方案](#12-安全加固方案)
13. [实施路线图](#13-实施路线图)
14. [测试策略](#14-测试策略)
15. [运维与监控](#15-运维与监控)
16. [附录：代码示例](#16-附录代码示例)

---

## 1. 执行摘要

### 1.1 项目背景

本文档旨在为企业级应用设计一套完整的 RBAC（Role-Based Access Control）权限系统架构。当前系统基于 RuoYi-Vue-Plus 的设计思想，实现了基础的用户-角色-权限模型，但在以下方面存在重构需求：

- **架构清晰度**: 需要更明确的职责边界和模块划分
- **扩展性**: 需要支持更复杂的权限场景（如多租户、动态权限）
- **性能**: 需要优化高并发场景下的权限校验性能
- **安全性**: 需要加强会话管理和权限变更的一致性保障

### 1.2 设计目标

| 目标维度 | 具体指标 |
|---------|---------|
| **性能** | 权限校验 < 5ms (P99)，支持 10K+ QPS |
| **可用性** | 99.9% 可用性，权限变更即时生效 |
| **安全性** | 零信任架构，会话泄露影响面最小化 |
| **可维护性** | 模块化设计，核心逻辑测试覆盖率 > 90% |
| **扩展性** | 支持插件化权限策略，支持多租户扩展 |

---

## 2. 当前系统分析

### 2.1 系统概览

当前系统实现了一个基于 **五表模型** 的 RBAC 系统：

```
User (用户)
  ↓ N:M
Role (角色)
  ↓ N:M
Menu (菜单/权限点)

User → Dept (部门) → 数据权限范围
Role → dataScope + RoleDept → 数据权限规则
```

### 2.2 核心实体关系

**主实体表**:
- `sys_user`: 用户基础信息
- `sys_role`: 角色定义
- `sys_menu`: 菜单与功能权限
- `sys_dept`: 组织架构（部门树）
- `sys_post`: 岗位定义

**关联表**:
- `sys_user_role`: 用户-角色多对多关系
- `sys_role_menu`: 角色-菜单多对多关系
- `sys_role_dept`: 角色自定义数据范围的部门关联
- `sys_user_post`: 用户-岗位多对多关系

### 2.3 当前实现的优势

#### 2.3.1 认证流程 (AuthService)

**优点**:
1. **双 Token 机制**: AccessToken 短期有效 + RefreshToken 长期有效，平衡安全与体验
2. **会话隔离**: 每个设备独立 sessionId，支持单点登出和全局登出
3. **Token 轮换**: RefreshToken 使用后立即轮换，防止重放攻击
4. **快照机制**: 权限快照存储在会话中，避免每次请求都查询数据库

**工作流程**:
```
登录 → 生成权限快照 → 创建会话(Redis) → 返回 Token 对
请求 → 验证 AccessToken → 加载会话 → 重新加载用户数据范围 → 授权决策
```

#### 2.3.2 授权引擎 (PermissionService)

**优点**:
1. **通配符匹配**: 支持 `*:*:*` 模式权限，兼容 Sa-Token 语义
2. **AND/OR 组合**: 单个装饰器支持 AND/OR 模式，多个装饰器默认 AND
3. **角色兜底**: `@Permission` 支持 role 参数，任一角色满足即可通过
4. **快照鉴权**: 运行时只读内存快照，不查库

**示例**:
```typescript
@Permission({ value: ['system:user:edit', 'system:user:add'], mode: Mode.OR, role: 'admin' })
// 含义: 需要 edit 或 add 权限，或者拥有 admin 角色
```

#### 2.3.3 数据权限 (DataScope)

**优点**:
1. **五种范围策略**:
   - `1` 全部数据: 无限制
   - `2` 本部门: 仅当前用户所属部门
   - `3` 本部门及以下: 当前部门 + 子部门（物化路径查询）
   - `4` 仅本人: 记录的 userId 匹配当前用户
   - `5` 自定义: RoleDept 显式指定的部门列表

2. **多角色并集**: 用户多个角色的数据范围取并集，扩大可见范围
3. **失败关闭**: 无有效角色时退化为空范围（拒绝），而非全量放行
4. **实时加载**: 数据范围不进会话快照，每次请求重新加载，调整立即生效

**组装逻辑**:
```typescript
// 生成 Prisma 查询条件
const where = withDataScope(
  { delFlag: '0', status: query.status },  // 业务条件
  await loadDataScope(prisma, actor),      // 数据范围
  { dept: 'deptId', self: 'userId' }       // 归属列映射
);
```

#### 2.3.4 部门树结构

**优点**:
1. **物化路径**: `ancestors` 字段存储 `/1/2/3/` 格式路径，支持高效子树查询
2. **索引优化**: `ancestors` 字段有索引，`LIKE '%/10/%'` 查询性能良好
3. **避免递归**: 不需要递归 CTE，单次查询获取子树

### 2.4 当前实现的问题与挑战

#### 2.4.1 架构层面

**问题 1: 权限快照一致性**
- **现象**: 角色菜单变更后，必须手动撤销所有相关用户会话
- **影响**: 撤销失败会导致旧权限继续生效，存在安全风险
- **根因**: 快照与源数据分离，缺乏自动同步机制

**问题 2: 数据权限性能**
- **现象**: 每次请求都重新加载数据范围（查询用户角色、角色部门）
- **影响**: 高并发场景下数据库压力大
- **根因**: 实时加载策略与性能需求矛盾

**问题 3: 会话存储依赖**
- **现象**: 严重依赖 Redis，Redis 故障导致全站认证失效
- **影响**: 单点故障，可用性受限
- **根因**: 无会话降级或备份机制

#### 2.4.2 数据模型层面

**问题 4: 角色粒度不够**
- **现象**: 一个角色同时承载功能权限和数据权限
- **影响**: 细粒度授权困难（如"可查看所有用户，但只能编辑本部门"）
- **根因**: 缺少权限维度分离

**问题 5: 岗位未充分利用**
- **现象**: Post 表存在但只是用户属性，未参与权限计算
- **影响**: 无法实现岗位级权限（如"部门经理自动拥有本部门数据权限"）
- **根因**: 设计时未考虑岗位的权限语义

**问题 6: 菜单类型混杂**
- **现象**: Menu 既是导航菜单（M/C）又是权限点（F），还混合了路由配置
- **影响**: 前端菜单结构与后端权限耦合，难以独立演化
- **根因**: 单表承载多重职责

#### 2.4.3 安全层面

**问题 7: 超级管理员硬编码**
- **现象**: `userId === '1'` 即为超管，无法转移或撤销
- **影响**: 1 号账号成为永久后门，无法满足审计要求
- **根因**: 身份判定逻辑硬编码

**问题 8: 会话撤销非原子**
- **现象**: 数据库事务提交后异步撤销会话，撤销失败只打日志
- **影响**: 权限变更不能保证立即生效
- **根因**: 跨存储（PostgreSQL + Redis）的分布式一致性问题

#### 2.4.4 扩展性层面

**问题 9: 无审计日志**
- **现象**: 权限变更、会话创建/撤销无详细日志
- **影响**: 安全事件无法追溯
- **根因**: 未设计审计模块

**问题 10: 无权限版本控制**
- **现象**: 角色权限修改直接覆盖，无历史记录
- **影响**: 无法回滚，无法审计
- **根因**: 未考虑权限配置的可追溯性

---

## 3. RBAC 核心概念与企业级要求

### 3.1 RBAC 模型演进

#### 3.1.1 RBAC0 (基础模型)
```
User → Role → Permission
```
- 用户被分配角色
- 角色拥有权限
- 用户通过角色间接获得权限

#### 3.1.2 RBAC1 (角色层次)
```
User → Role (支持继承) → Permission
```
- 角色可继承父角色的权限
- 示例: "部门经理"继承"普通员工"的所有权限

#### 3.1.3 RBAC2 (约束模型)
- **互斥角色**: 用户不能同时拥有冲突角色（如"会计"与"审计"）
- **基数约束**: 角色成员数量限制
- **先决条件**: 拥有角色 A 才能获得角色 B

#### 3.1.4 RBAC3 (综合模型)
RBAC1 + RBAC2 的组合

#### 3.1.5 扩展模型: ABAC 元素
**Attribute-Based Access Control**:
- 基于用户属性（部门、职级）
- 基于资源属性（数据分类、所有者）
- 基于环境属性（时间、IP、设备）

### 3.2 企业级 RBAC 的核心要求

| 需求类别 | 具体要求 | 优先级 |
|---------|---------|--------|
| **功能完整性** | 支持角色继承、权限分组、动态权限 | P0 |
| **数据安全** | 行级/字段级数据权限、数据脱敏 | P0 |
| **审计合规** | 完整的权限操作日志、变更追踪 | P0 |
| **性能** | 权限校验 < 10ms，支持高并发 | P0 |
| **高可用** | 认证服务 99.9% 可用，支持降级 | P1 |
| **可扩展** | 支持插件式权限策略、多租户 | P1 |
| **用户体验** | 权限变更秒级生效、友好的错误提示 | P2 |

### 3.3 权限类型分类

#### 3.3.1 功能权限 (Functional Permission)
- **定义**: 控制用户能执行哪些操作
- **示例**: `system:user:add`, `system:user:delete`
- **实现**: 通过装饰器 + 守卫实现

#### 3.3.2 数据权限 (Data Permission)
- **定义**: 控制用户能访问哪些数据
- **示例**: 只能看本部门数据、只能看自己创建的记录
- **实现**: 通过查询条件注入实现

#### 3.3.3 字段权限 (Field Permission)
- **定义**: 控制用户能看到数据的哪些字段
- **示例**: 普通员工看不到薪资字段
- **实现**: 通过响应拦截器或 GraphQL 字段解析器实现

#### 3.3.4 操作权限 (Action Permission)
- **定义**: 特定资源的特定操作
- **示例**: 可以"批准"某个审批单
- **实现**: 结合资源状态和用户角色的策略判定

---

## 4. 架构设计原则

### 4.1 核心设计原则

#### 4.1.1 最小权限原则 (Principle of Least Privilege)
- 默认拒绝，显式授权
- 用户只获得完成工作所需的最小权限
- 临时权限及时回收

#### 4.1.2 职责分离 (Separation of Duties)
- 敏感操作需要多角色协作
- 审批人不能是申请人
- 关键配置变更需要双人确认

#### 4.1.3 深度防御 (Defense in Depth)
- 多层权限校验（网关 + 服务层 + 数据层）
- 认证与授权分离
- 会话与权限配置分离

#### 4.1.4 失败安全 (Fail-Safe Defaults)
- 异常情况下拒绝访问而非放行
- 权限配置错误时降级为最小权限
- 缓存失效时回源校验

### 4.2 模块化设计

```
┌─────────────────────────────────────────────────────┐
│                   Gateway Layer                      │
│              (认证 + 粗粒度授权)                      │
└────────────┬────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────┐
│                  Service Layer                       │
│         (细粒度授权 + 数据权限注入)                   │
└────────────┬────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────┐
│                  Data Layer                          │
│            (强制数据过滤 + 审计日志)                  │
└─────────────────────────────────────────────────────┘
```

**模块职责**:
1. **Authentication Module**: 用户身份验证、会话管理
2. **Authorization Module**: 权限决策、策略引擎
3. **RBAC Core Module**: 用户、角色、权限的 CRUD
4. **Data Scope Module**: 数据权限计算与注入
5. **Audit Module**: 权限操作审计日志
6. **Session Module**: 会话存储、Token 管理

### 4.3 数据流设计

#### 4.3.1 认证流程

```
用户登录
    ↓
验证账号密码
    ↓
计算权限快照 (roles + permissions)
    ↓
创建会话 (sessionId + 快照)
    ↓
生成 AccessToken (含 sessionId)
    ↓
返回 Token 对
```

#### 4.3.2 授权流程

```
请求到达
    ↓
AuthGuard: 验证 AccessToken
    ↓
加载会话快照 (roles + permissions)
    ↓
重新加载数据范围 (dataScopes)
    ↓
PermissionGuard: 检查功能权限
    ↓
Service: 注入数据权限条件
    ↓
返回过滤后的数据
```

#### 4.3.3 权限变更流程

```
修改角色权限
    ↓
事务提交
    ↓
发布权限变更事件
    ↓
撤销相关用户会话 (异步)
    ↓
记录审计日志
    ↓
通知用户 (可选)
```

---

## 5. 数据模型设计

### 5.1 核心实体设计

#### 5.1.1 用户表 (sys_user)

```sql
CREATE TABLE sys_user (
  user_id         BIGSERIAL PRIMARY KEY,
  username        VARCHAR(64) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  nickname        VARCHAR(100),
  email           VARCHAR(254),
  phone           VARCHAR(32),
  avatar_url      VARCHAR(512),
  
  -- 组织归属
  dept_id         BIGINT REFERENCES sys_dept(dept_id),
  primary_post_id BIGINT REFERENCES sys_post(post_id),
  
  -- 状态
  status          CHAR(1) DEFAULT '0' CHECK (status IN ('0', '1')), -- 0:正常 1:停用
  locked_until    TIMESTAMP,  -- 锁定到期时间
  
  -- 安全
  login_failures  INT DEFAULT 0,
  last_login_ip   VARCHAR(128),
  last_login_at   TIMESTAMP,
  pwd_changed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- 审计
  created_by      BIGINT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP,  -- 软删除
  
  CONSTRAINT uk_user_username UNIQUE (username) WHERE deleted_at IS NULL
);

CREATE INDEX idx_user_dept ON sys_user(dept_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_status ON sys_user(status) WHERE deleted_at IS NULL;
```

**设计说明**:
- `password_hash`: 使用 Argon2id 算法，而非明文或弱哈希
- `locked_until`: 支持临时锁定（如连续登录失败）
- `deleted_at`: 软删除，保留历史数据用于审计
- `pwd_changed_at`: 支持密码过期策略

#### 5.1.2 角色表 (sys_role)

```sql
CREATE TABLE sys_role (
  role_id          BIGSERIAL PRIMARY KEY,
  role_key         VARCHAR(64) NOT NULL,  -- 唯一标识，如 'admin', 'user'
  role_name        VARCHAR(100) NOT NULL,
  parent_role_id   BIGINT REFERENCES sys_role(role_id),  -- 角色继承
  role_type        VARCHAR(20) DEFAULT 'BUSINESS',  -- SYSTEM/BUSINESS/CUSTOM
  
  -- 数据权限（保留兼容）
  data_scope       CHAR(1) DEFAULT '1',
  
  -- 约束
  max_members      INT,  -- 成员数上限
  mutually_exclusive_with BIGINT[],  -- 互斥角色列表
  
  -- 状态
  status           CHAR(1) DEFAULT '0',
  effective_from   TIMESTAMP,
  effective_until  TIMESTAMP,
  
  -- 审计
  created_by       BIGINT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by       BIGINT,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP,
  
  CONSTRAINT uk_role_key UNIQUE (role_key) WHERE deleted_at IS NULL
);

CREATE INDEX idx_role_parent ON sys_role(parent_role_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_role_type ON sys_role(role_type);
```

**新增字段**:
- `parent_role_id`: 支持角色继承（RBAC1）
- `role_type`: 区分系统角色与业务角色
- `mutually_exclusive_with`: 支持互斥约束（RBAC2）
- `effective_from/until`: 支持临时角色

#### 5.1.3 权限表 (sys_permission)

```sql
CREATE TABLE sys_permission (
  permission_id    BIGSERIAL PRIMARY KEY,
  permission_code  VARCHAR(100) NOT NULL,  -- system:user:add
  permission_name  VARCHAR(100) NOT NULL,
  permission_type  VARCHAR(20) NOT NULL,   -- MENU/BUTTON/API/DATA
  resource_type    VARCHAR(50),            -- 资源类型: USER/DEPT/ORDER
  
  -- 分组
  module_id        BIGINT REFERENCES sys_permission_module(module_id),
  parent_id        BIGINT REFERENCES sys_permission(permission_id),
  
  -- 描述
  description      TEXT,
  risk_level       VARCHAR(20) DEFAULT 'LOW',  -- LOW/MEDIUM/HIGH/CRITICAL
  
  -- 状态
  status           CHAR(1) DEFAULT '0',
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP,
  
  CONSTRAINT uk_permission_code UNIQUE (permission_code) WHERE deleted_at IS NULL
);

CREATE INDEX idx_permission_type ON sys_permission(permission_type);
CREATE INDEX idx_permission_module ON sys_permission(module_id);
```

**设计理念**:
- 将权限从菜单表中独立出来
- `permission_type` 支持多种权限类型
- `risk_level` 用于敏感操作的额外审核

#### 5.1.4 菜单表 (sys_menu)

```sql
CREATE TABLE sys_menu (
  menu_id          BIGSERIAL PRIMARY KEY,
  parent_id        BIGINT DEFAULT 0,
  menu_name        VARCHAR(64) NOT NULL,
  menu_type        CHAR(1) NOT NULL,  -- M:目录 C:菜单 L:链接
  
  -- 路由配置（仅前端使用）
  route_path       VARCHAR(200),
  route_name       VARCHAR(100),
  component_path   VARCHAR(255),
  redirect_path    VARCHAR(200),
  
  -- 显示配置
  icon             VARCHAR(100),
  order_num        INT DEFAULT 0,
  is_visible       BOOLEAN DEFAULT true,
  is_cached        BOOLEAN DEFAULT false,
  is_external      BOOLEAN DEFAULT false,
  
  -- 关联权限（可选）
  permission_id    BIGINT REFERENCES sys_permission(permission_id),
  
  -- 状态
  status           CHAR(1) DEFAULT '0',
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP,
  
  CONSTRAINT chk_menu_type CHECK (menu_type IN ('M', 'C', 'L'))
);

CREATE INDEX idx_menu_parent ON sys_menu(parent_id);
CREATE INDEX idx_menu_permission ON sys_menu(permission_id);
```

**重构要点**:
- 移除 `perms` 字段，通过 `permission_id` 关联
- 菜单专注于前端导航，权限控制交给 sys_permission
- 一个菜单可以关联一个权限，但权限可以独立存在

#### 5.1.5 部门表 (sys_dept)

```sql
CREATE TABLE sys_dept (
  dept_id          BIGSERIAL PRIMARY KEY,
  parent_id        BIGINT DEFAULT 0,
  ancestors        VARCHAR(512) DEFAULT '/',  -- 物化路径
  dept_code        VARCHAR(64),
  dept_name        VARCHAR(64) NOT NULL,
  dept_type        VARCHAR(20),  -- COMPANY/DEPARTMENT/TEAM
  
  -- 负责人
  leader_id        BIGINT REFERENCES sys_user(user_id),
  deputy_leader_ids BIGINT[],
  
  -- 显示
  order_num        INT DEFAULT 0,
  
  -- 状态
  status           CHAR(1) DEFAULT '0',
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP,
  
  CONSTRAINT uk_dept_code UNIQUE (dept_code) WHERE deleted_at IS NULL
);

CREATE INDEX idx_dept_parent ON sys_dept(parent_id);
CREATE INDEX idx_dept_ancestors ON sys_dept USING GIN (ancestors gin_trgm_ops);
CREATE INDEX idx_dept_leader ON sys_dept(leader_id);
```

**优化点**:
- `ancestors` 使用 GIN 索引提升子树查询性能
- `deputy_leader_ids` 支持多负责人
- `dept_type` 支持部门分类

#### 5.1.6 岗位表 (sys_post)

```sql
CREATE TABLE sys_post (
  post_id          BIGSERIAL PRIMARY KEY,
  post_code        VARCHAR(64) NOT NULL,
  post_name        VARCHAR(64) NOT NULL,
  dept_id          BIGINT REFERENCES sys_dept(dept_id),
  
  -- 岗位级别（用于权限判定）
  post_level       INT,  -- 数字越大级别越高
  post_category    VARCHAR(50),  -- MANAGEMENT/TECHNICAL/OPERATIONAL
  
  -- 岗位职责（关联权限）
  default_role_ids BIGINT[],  -- 该岗位默认赋予的角色
  
  -- 显示
  order_num        INT DEFAULT 0,
  description      TEXT,
  
  -- 状态
  status           CHAR(1) DEFAULT '0',
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP,
  
  CONSTRAINT uk_post_code_dept UNIQUE (post_code, dept_id) WHERE deleted_at IS NULL
);

CREATE INDEX idx_post_dept ON sys_post(dept_id);
CREATE INDEX idx_post_level ON sys_post(post_level);
```

**增强点**:
- `post_level` 用于层级权限判定
- `default_role_ids` 实现岗位与角色的自动关联
- 岗位与部门关联，支持跨部门同名岗位

### 5.2 关联表设计

#### 5.2.1 用户角色表 (sys_user_role)

```sql
CREATE TABLE sys_user_role (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES sys_user(user_id) ON DELETE CASCADE,
  role_id          BIGINT NOT NULL REFERENCES sys_role(role_id) ON DELETE CASCADE,
  
  -- 授权来源
  granted_by       VARCHAR(50) DEFAULT 'MANUAL',  -- MANUAL/POST/DEPT/TEMPORARY
  source_id        BIGINT,  -- 来源ID（如岗位ID）
  
  -- 有效期
  effective_from   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  effective_until  TIMESTAMP,
  
  -- 审计
  granted_by_user  BIGINT REFERENCES sys_user(user_id),
  granted_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_by_user  BIGINT REFERENCES sys_user(user_id),
  revoked_at       TIMESTAMP,
  
  CONSTRAINT uk_user_role UNIQUE (user_id, role_id, effective_from)
);

CREATE INDEX idx_ur_user ON sys_user_role(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_ur_role ON sys_user_role(role_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_ur_expire ON sys_user_role(effective_until) WHERE effective_until IS NOT NULL;
```

**新增特性**:
- `granted_by`: 追踪角色来源（手动分配 vs 岗位继承）
- `effective_from/until`: 支持临时授权
- 审计字段记录授权和撤销操作

#### 5.2.2 角色权限表 (sys_role_permission)

```sql
CREATE TABLE sys_role_permission (
  id               BIGSERIAL PRIMARY KEY,
  role_id          BIGINT NOT NULL REFERENCES sys_role(role_id) ON DELETE CASCADE,
  permission_id    BIGINT NOT NULL REFERENCES sys_permission(permission_id) ON DELETE CASCADE,
  
  -- 权限模式
  access_mode      VARCHAR(20) DEFAULT 'ALLOW',  -- ALLOW/DENY
  
  -- 约束条件（JSON）
  constraints      JSONB,  -- 如: {"time": "09:00-18:00", "ip_whitelist": [...]}
  
  -- 审计
  granted_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by       BIGINT REFERENCES sys_user(user_id),
  
  CONSTRAINT uk_role_permission UNIQUE (role_id, permission_id)
);

CREATE INDEX idx_rp_role ON sys_role_permission(role_id);
CREATE INDEX idx_rp_permission ON sys_role_permission(permission_id);
CREATE INDEX idx_rp_constraints ON sys_role_permission USING GIN (constraints);
```

**高级特性**:
- `access_mode`: 支持黑名单模式（显式拒绝）
- `constraints`: 支持条件权限（ABAC 元素）

#### 5.2.3 数据权限策略表 (sys_data_permission)

```sql
CREATE TABLE sys_data_permission (
  id               BIGSERIAL PRIMARY KEY,
  role_id          BIGINT NOT NULL REFERENCES sys_role(role_id) ON DELETE CASCADE,
  resource_type    VARCHAR(50) NOT NULL,  -- USER/DEPT/ORDER 等业务实体
  
  -- 策略类型
  scope_type       VARCHAR(20) NOT NULL,  -- ALL/DEPT/DEPT_AND_CHILD/SELF/CUSTOM/CREATOR
  
  -- 自定义范围（JSON）
  scope_config     JSONB,  -- {"dept_ids": [1,2,3], "conditions": {...}}
  
  -- 字段权限
  allowed_fields   TEXT[],  -- 可见字段白名单
  masked_fields    TEXT[],  -- 需要脱敏的字段
  
  -- 操作限制
  allowed_actions  TEXT[],  -- ['READ', 'CREATE', 'UPDATE']
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT uk_data_perm UNIQUE (role_id, resource_type)
);

CREATE INDEX idx_dp_role ON sys_data_permission(role_id);
CREATE INDEX idx_dp_resource ON sys_data_permission(resource_type);
CREATE INDEX idx_dp_config ON sys_data_permission USING GIN (scope_config);
```

**设计理念**:
- 将数据权限从角色表的单个字段扩展为独立策略表
- 支持不同资源类型的差异化策略
- `scope_config` 使用 JSONB 支持复杂的自定义规则
- 字段级权限控制（脱敏、隐藏）

### 5.3 审计表设计

#### 5.3.1 权限操作日志 (sys_permission_audit_log)

```sql
CREATE TABLE sys_permission_audit_log (
  id               BIGSERIAL PRIMARY KEY,
  
  -- 操作信息
  action_type      VARCHAR(50) NOT NULL,  -- GRANT_ROLE/REVOKE_ROLE/MODIFY_PERMISSION/LOGIN/LOGOUT
  target_type      VARCHAR(50),  -- USER/ROLE/PERMISSION
  target_id        BIGINT,
  
  -- 变更内容（JSON）
  before_state     JSONB,
  after_state      JSONB,
  change_detail    TEXT,
  
  -- 操作者
  operator_id      BIGINT REFERENCES sys_user(user_id),
  operator_ip      VARCHAR(128),
  user_agent       TEXT,
  
  -- 结果
  status           VARCHAR(20) DEFAULT 'SUCCESS',  -- SUCCESS/FAILURE/PENDING
  error_message    TEXT,
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- 合规标记
  is_sensitive     BOOLEAN DEFAULT false,
  reviewed_by      BIGINT REFERENCES sys_user(user_id),
  reviewed_at      TIMESTAMP
);

CREATE INDEX idx_pal_action ON sys_permission_audit_log(action_type, created_at);
CREATE INDEX idx_pal_target ON sys_permission_audit_log(target_type, target_id);
CREATE INDEX idx_pal_operator ON sys_permission_audit_log(operator_id, created_at);
CREATE INDEX idx_pal_sensitive ON sys_permission_audit_log(is_sensitive) WHERE is_sensitive = true;
```

**审计要点**:
- 记录所有权限相关操作
- `before_state` / `after_state` 完整记录变更前后状态
- `is_sensitive` 标记高风险操作，需要人工复核

#### 5.3.2 会话审计表 (sys_session_audit)

```sql
CREATE TABLE sys_session_audit (
  id               BIGSERIAL PRIMARY KEY,
  session_id       UUID NOT NULL,
  user_id          BIGINT NOT NULL REFERENCES sys_user(user_id),
  
  -- 会话事件
  event_type       VARCHAR(50) NOT NULL,  -- CREATE/REFRESH/REVOKE/EXPIRE
  
  -- 设备信息
  device_id        VARCHAR(128),
  device_type      VARCHAR(50),  -- WEB/MOBILE/API
  ip_address       VARCHAR(128),
  user_agent       TEXT,
  geolocation      JSONB,
  
  -- 会话信息
  access_token_jti UUID,
  expires_at       TIMESTAMP,
  
  -- 审计
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- 异常标记
  is_anomaly       BOOLEAN DEFAULT false,
  anomaly_reason   TEXT
);

CREATE INDEX idx_sa_session ON sys_session_audit(session_id, created_at);
CREATE INDEX idx_sa_user ON sys_session_audit(user_id, created_at);
CREATE INDEX idx_sa_event ON sys_session_audit(event_type, created_at);
CREATE INDEX idx_sa_anomaly ON sys_session_audit(is_anomaly) WHERE is_anomaly = true;
```

**安全特性**:
- 追踪每个会话的完整生命周期
- `is_anomaly` 标记异常登录（如异地、新设备）
- 支持设备指纹识别

### 5.4 数据关系图

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   User      │──────>│  UserRole   │<──────│    Role     │
│             │       │             │       │             │
│  - dept_id  │       │ - granted_by│       │ - parent_id │
│  - post_id  │       │ - expire    │       │ - data_scope│
└─────────────┘       └─────────────┘       └─────────────┘
      │                                              │
      │                                              │
      ▼                                              ▼
┌─────────────┐                           ┌──────────────────┐
│    Dept     │                           │ RolePermission   │
│             │                           │                  │
│ - ancestors │                           │ - access_mode    │
│ - leader_id │                           │ - constraints    │
└─────────────┘                           └──────────────────┘
      │                                              │
      │                                              ▼
      │                                    ┌──────────────────┐
      │                                    │   Permission     │
      │                                    │                  │
      │                                    │ - permission_code│
      │                                    │ - risk_level     │
      │                                    └──────────────────┘
      │                                              │
      │                                              │
      ▼                                              ▼
┌─────────────┐                           ┌──────────────────┐
│  RoleDept   │                           │      Menu        │
│             │                           │                  │
│(自定义范围) │                           │ - permission_id  │
└─────────────┘                           └──────────────────┘
```

### 5.5 迁移策略

从当前模型迁移到新模型：

**阶段 1: 准备期（无停机）**
```sql
-- 1. 创建新表
CREATE TABLE sys_permission (...);
CREATE TABLE sys_data_permission (...);
CREATE TABLE sys_permission_audit_log (...);

-- 2. 迁移现有数据
-- 从 sys_menu.perms 提取权限
INSERT INTO sys_permission (permission_code, permission_name, permission_type)
SELECT DISTINCT perms, perms, 'BUTTON'
FROM sys_menu
WHERE perms IS NOT NULL AND status = '0';

-- 3. 建立关联
UPDATE sys_menu m
SET permission_id = (
  SELECT permission_id FROM sys_permission p 
  WHERE p.permission_code = m.perms
)
WHERE m.perms IS NOT NULL;
```

**阶段 2: 双写期（无停机）**
```typescript
// 同时写入旧表和新表
await tx.menu.update({ data: { perms: newPerms } });
await tx.permission.upsert({ where: { code: newPerms }, ... });
```

**阶段 3: 切换期（短暂停机）**
```sql
-- 验证数据一致性
SELECT COUNT(*) FROM sys_menu m
LEFT JOIN sys_permission p ON m.permission_id = p.permission_id
WHERE m.perms IS NOT NULL AND p.permission_id IS NULL;

-- 切换应用读取逻辑
-- 部署新版本代码（从 sys_permission 读取）
```

**阶段 4: 清理期（无停机）**
```sql
-- 移除冗余字段
ALTER TABLE sys_menu DROP COLUMN perms;
```

---

## 6. 认证模块架构

### 6.1 认证流程设计

#### 6.1.1 登录认证流程

```typescript
/**
 * 企业级登录认证流程
 */
async function authenticateUser(credentials: LoginCredentials): Promise<AuthResult> {
  // 1. 预检查：防止暴力破解
  await rateLimiter.checkLoginAttempts(credentials.username);
  
  // 2. 查询用户（防止时间侧信道攻击）
  const users = await findUsersByUsername(credentials.username);
  const user = users.length === 1 ? users[0] : null;
  
  // 3. 密码验证（即使用户不存在也要执行哈希，保持时间一致）
  const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
  const isValid = await verifyPassword(credentials.password, hashToVerify);
  
  // 4. 验证结果判定
  if (!user || !isValid) {
    await recordFailedAttempt(credentials.username);
    throw new UnauthorizedException('账号或密码错误');
  }
  
  // 5. 账号状态检查
  if (user.status !== 'ACTIVE') {
    throw new ForbiddenException('账号已停用');
  }
  
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new ForbiddenException(`账号已锁定至 ${user.lockedUntil}`);
  }
  
  // 6. 密码过期检查
  const passwordAge = Date.now() - user.pwdChangedAt.getTime();
  if (passwordAge > PASSWORD_MAX_AGE_MS) {
    return { requirePasswordChange: true, user };
  }
  
  // 7. 计算权限快照
  const snapshot = await computeAuthSnapshot(user.userId);
  
  // 8. 创建会话
  const session = await sessionManager.create({
    userId: user.userId,
    snapshot,
    deviceInfo: credentials.deviceInfo,
    ipAddress: credentials.ipAddress,
  });
  
  // 9. 生成 Token 对
  const tokens = await tokenService.generateTokenPair(session);
  
  // 10. 更新登录信息
  await updateLoginInfo(user.userId, credentials.ipAddress);
  
  // 11. 审计日志
  await auditLogger.log({
    action: 'LOGIN_SUCCESS',
    userId: user.userId,
    ipAddress: credentials.ipAddress,
    deviceInfo: credentials.deviceInfo,
  });
  
  return { tokens, user, snapshot };
}
```

#### 6.1.2 Token 生成策略

**AccessToken 结构**:
```typescript
interface AccessTokenPayload {
  sub: string;        // 用户 ID
  sid: string;        // 会话 ID (UUID)
  jti: string;        // Token ID (UUID, 防重放)
  iat: number;        // 签发时间
  exp: number;        // 过期时间 (15分钟)
  type: 'access';
}
```

**RefreshToken 结构**:
```typescript
// 格式: {sessionId}.{randomToken}
// 例如: 550e8400-e29b-41d4-a716-446655440000.7Xj9kP2mN5qR8wT4vL1bC6dF3gH0sA
interface RefreshToken {
  sessionId: string;  // 与 AccessToken 的 sid 对应
  token: string;      // 32字节随机数，Base64URL 编码
}

// Redis 存储格式
interface StoredSession {
  userId: string;
  refreshHash: string;              // SHA256(refreshToken)
  expiresAt: number;                // 30天后
  roles: string[];                  // 权限快照
  permissions: string[];
  deviceInfo: DeviceFingerprint;
}
```

**Token 轮换机制**:
```typescript
async function refreshAccessToken(refreshToken: string): Promise<TokenPair> {
  // 1. 解析 RefreshToken
  const [sessionId, tokenPart] = refreshToken.split('.');
  
  // 2. 加载会话
  const session = await redis.get(`session:${sessionId}`);
  if (!session) throw new UnauthorizedException('会话不存在');
  
  // 3. 验证 Token（防止泄露后的重放）
  const tokenHash = sha256(refreshToken);
  if (tokenHash !== session.refreshHash) {
    // 检测到 Token 重用，可能泄露，撤销该会话
    await redis.del(`session:${sessionId}`);
    await auditLogger.log({
      action: 'TOKEN_REUSE_DETECTED',
      sessionId,
      severity: 'CRITICAL',
    });
    throw new UnauthorizedException('检测到异常，已撤销会话');
  }
  
  // 4. 检查会话有效性
  if (Date.now() > session.expiresAt) {
    throw new UnauthorizedException('会话已过期');
  }
  
  // 5. 重新加载用户（验证用户仍然有效）
  const user = await loadUser(session.userId);
  
  // 6. 生成新的 RefreshToken
  const newRefreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
  const newRefreshHash = sha256(newRefreshToken);
  
  // 7. 原子性更新会话（使用 Lua 脚本保证原子性）
  await redis.eval(`
    local key = KEYS[1]
    local oldHash = ARGV[1]
    local newHash = ARGV[2]
    local session = redis.call('GET', key)
    if not session then return nil end
    local data = cjson.decode(session)
    if data.refreshHash ~= oldHash then return nil end
    data.refreshHash = newHash
    redis.call('SET', key, cjson.encode(data), 'EXAT', data.expiresAt)
    return 1
  `, [`session:${sessionId}`], [session.refreshHash, newRefreshHash]);
  
  // 8. 生成新的 AccessToken
  const accessToken = await jwt.sign({
    sub: session.userId,
    sid: sessionId,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,  // 15分钟
    type: 'access',
  });
  
  return { accessToken, refreshToken: newRefreshToken };
}
```

### 6.2 会话管理架构

#### 6.2.1 会话存储策略

**主存储：Redis**
```typescript
// 会话键设计
const SESSION_KEY = `session:${sessionId}`;           // 会话数据
const USER_SESSIONS_KEY = `user:${userId}:sessions`; // 用户的所有会话（Set）
const SESSION_INDEX_KEY = `session:index`;           // 全局会话索引（Sorted Set，按过期时间）

// 存储操作
async function createSession(session: Session): Promise<void> {
  const ttl = Math.floor((session.expiresAt - Date.now()) / 1000);
  
  await redis.multi()
    .set(SESSION_KEY, JSON.stringify(session), 'EX', ttl)
    .sadd(USER_SESSIONS_KEY, sessionId)
    .zadd(SESSION_INDEX_KEY, session.expiresAt, sessionId)
    .exec();
}
```

**备份存储：PostgreSQL**
```sql
-- 会话快照表（用于灾难恢复）
CREATE TABLE sys_session_snapshot (
  session_id       UUID PRIMARY KEY,
  user_id          BIGINT NOT NULL,
  refresh_hash     VARCHAR(64) NOT NULL,
  snapshot_data    JSONB NOT NULL,
  expires_at       TIMESTAMP NOT NULL,
  last_synced_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ss_user ON sys_session_snapshot(user_id);
CREATE INDEX idx_ss_expire ON sys_session_snapshot(expires_at);
```

**双写策略**:
```typescript
async function createSessionWithBackup(session: Session): Promise<void> {
  // 主写入 Redis
  await redis.set(`session:${session.id}`, JSON.stringify(session), 'EX', session.ttl);
  
  // 异步备份到 PostgreSQL（非阻塞）
  setImmediate(async () => {
    try {
      await db.sessionSnapshot.upsert({
        where: { sessionId: session.id },
        create: {
          sessionId: session.id,
          userId: session.userId,
          refreshHash: session.refreshHash,
          snapshotData: session.snapshot,
          expiresAt: new Date(session.expiresAt),
        },
        update: { lastSyncedAt: new Date() },
      });
    } catch (error) {
      logger.warn('Session backup failed', { sessionId: session.id, error });
    }
  });
}
```

#### 6.2.2 会话失效策略

**多层失效机制**:
```typescript
enum SessionInvalidationReason {
  LOGOUT = 'LOGOUT',                  // 用户主动登出
  REVOKED = 'REVOKED',                // 管理员撤销
  EXPIRED = 'EXPIRED',                // 自然过期
  PASSWORD_CHANGED = 'PASSWORD_CHANGED', // 密码变更
  PERMISSION_CHANGED = 'PERMISSION_CHANGED', // 权限变更
  SECURITY_EVENT = 'SECURITY_EVENT',  // 安全事件（如密码泄露）
}

async function invalidateSession(
  sessionId: string, 
  reason: SessionInvalidationReason
): Promise<void> {
  const session = await redis.get(`session:${sessionId}`);
  if (!session) return;
  
  // 1. 记录审计日志
  await auditLogger.log({
    action: 'SESSION_INVALIDATED',
    sessionId,
    reason,
    timestamp: Date.now(),
  });
  
  // 2. 从 Redis 删除
  await redis.multi()
    .del(`session:${sessionId}`)
    .srem(`user:${session.userId}:sessions`, sessionId)
    .zrem('session:index', sessionId)
    .exec();
  
  // 3. 添加到黑名单（AccessToken 可能还在有效期内）
  const blacklistTTL = Math.max(0, session.expiresAt - Date.now());
  await redis.set(
    `blacklist:${sessionId}`, 
    reason, 
    'PX', 
    blacklistTTL
  );
  
  // 4. 通知用户（可选）
  if (reason === SessionInvalidationReason.SECURITY_EVENT) {
    await notificationService.send({
      userId: session.userId,
      type: 'SECURITY_ALERT',
      message: '您的账号会话因安全原因被终止，请重新登录',
    });
  }
}
```

**批量撤销（权限变更后）**:
```typescript
async function revokeUserSessions(
  userId: string, 
  reason: SessionInvalidationReason
): Promise<number> {
  // 1. 获取用户所有会话
  const sessionIds = await redis.smembers(`user:${userId}:sessions`);
  
  if (sessionIds.length === 0) return 0;
  
  // 2. 批量失效
  const pipeline = redis.pipeline();
  for (const sessionId of sessionIds) {
    pipeline.del(`session:${sessionId}`);
    pipeline.zadd('blacklist:session', Date.now() + 900000, sessionId); // 黑名单15分钟
  }
  pipeline.del(`user:${userId}:sessions`);
  
  await pipeline.exec();
  
  // 3. 审计日志
  await auditLogger.log({
    action: 'BULK_SESSION_REVOKED',
    userId,
    count: sessionIds.length,
    reason,
  });
  
  return sessionIds.length;
}
```

### 6.3 多因素认证（MFA）架构

#### 6.3.1 MFA 流程设计

```typescript
/**
 * MFA 两阶段认证
 */
async function loginWithMFA(credentials: LoginCredentials): Promise<MFAChallenge | AuthResult> {
  // 第一阶段：账号密码验证
  const user = await verifyCredentials(credentials);
  
  // 检查是否启用 MFA
  if (!user.mfaEnabled) {
    return await completeLogin(user);
  }
  
  // 第二阶段：生成 MFA 挑战
  const challenge = await mfaService.createChallenge({
    userId: user.userId,
    methods: user.mfaMethods,  // ['TOTP', 'SMS', 'EMAIL']
    expiresIn: 300,  // 5分钟
  });
  
  return {
    requireMFA: true,
    challengeId: challenge.id,
    availableMethods: challenge.methods,
  };
}

async function verifyMFAChallenge(
  challengeId: string,
  method: MFAMethod,
  code: string
): Promise<AuthResult> {
  // 1. 加载挑战
  const challenge = await redis.get(`mfa:challenge:${challengeId}`);
  if (!challenge) throw new UnauthorizedException('挑战已过期');
  
  // 2. 验证码校验
  let isValid = false;
  switch (method) {
    case 'TOTP':
      isValid = await totpService.verify(challenge.userId, code);
      break;
    case 'SMS':
      isValid = await smsService.verify(challenge.userId, code);
      break;
    case 'EMAIL':
      isValid = await emailService.verify(challenge.userId, code);
      break;
  }
  
  if (!isValid) {
    await recordMFAFailure(challenge.userId);
    throw new UnauthorizedException('验证码错误');
  }
  
  // 3. 完成登录
  const user = await loadUser(challenge.userId);
  return await completeLogin(user);
}
```

#### 6.3.2 TOTP 实现

```typescript
/**
 * Time-based One-Time Password (Google Authenticator 兼容)
 */
class TOTPService {
  async generateSecret(userId: string): Promise<TOTPSecret> {
    const secret = authenticator.generateSecret();
    const qrCode = await QRCode.toDataURL(
      authenticator.keyuri(userId, 'YourApp', secret)
    );
    
    // 临时存储，等待用户验证后才持久化
    await redis.set(
      `totp:pending:${userId}`,
      secret,
      'EX',
      600  // 10分钟
    );
    
    return { secret, qrCode };
  }
  
  async verify(userId: string, token: string): Promise<boolean> {
    const secret = await db.userMFA.findUnique({
      where: { userId, method: 'TOTP' },
      select: { secret: true },
    });
    
    if (!secret) return false;
    
    // 允许时间窗口 ±1 步（30秒）
    return authenticator.verify({
      token,
      secret: secret.secret,
      window: 1,
    });
  }
}
```

---

## 7. 授权模块架构

### 7.1 权限决策引擎

#### 7.1.1 统一决策接口

```typescript
/**
 * 权限决策引擎 - 统一入口
 */
interface AuthorizationEngine {
  /**
   * 检查功能权限
   * @returns true 表示允许访问
   */
  checkPermission(
    user: AuthenticatedUser,
    permission: string | string[],
    mode?: 'AND' | 'OR'
  ): boolean;
  
  /**
   * 检查角色
   */
  hasRole(
    user: AuthenticatedUser,
    role: string | string[],
    mode?: 'AND' | 'OR'
  ): boolean;
  
  /**
   * 检查资源访问权限（结合 ABAC）
   */
  canAccessResource(
    user: AuthenticatedUser,
    resource: Resource,
    action: Action
  ): Promise<AccessDecision>;
  
  /**
   * 批量权限检查（用于菜单渲染）
   */
  batchCheck(
    user: AuthenticatedUser,
    checks: PermissionCheck[]
  ): Map<string, boolean>;
}

interface AccessDecision {
  allowed: boolean;
  reason?: string;
  constraints?: Record<string, any>;  // 条件约束（如只读、时间限制）
}
```

#### 7.1.2 权限匹配算法

```typescript
/**
 * 通配符权限匹配（Sa-Token 兼容）
 */
class PermissionMatcher {
  private exactPermissions: Set<string>;
  private wildcardPatterns: RegExp[];
  
  constructor(grantedPermissions: string[]) {
    this.exactPermissions = new Set();
    this.wildcardPatterns = [];
    
    for (const perm of grantedPermissions) {
      if (perm.includes('*')) {
        // 转换为正则表达式
        const pattern = perm
          .split('*')
          .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*');
        this.wildcardPatterns.push(new RegExp(`^${pattern}$`));
      } else {
        this.exactPermissions.add(perm);
      }
    }
  }
  
  matches(required: string): boolean {
    // 1. 精确匹配（O(1)）
    if (this.exactPermissions.has(required)) {
      return true;
    }
    
    // 2. 通配符匹配（O(n)，但 n 通常很小）
    return this.wildcardPatterns.some(pattern => pattern.test(required));
  }
  
  /**
   * 批量匹配优化
   */
  batchMatches(required: string[]): boolean[] {
    return required.map(perm => this.matches(perm));
  }
}

/**
 * 组合条件求值
 */
function evaluateRequirements(
  user: AuthenticatedUser,
  requirements: AccessRequirement[]
): boolean {
  const permMatcher = new PermissionMatcher(user.permissions);
  const roleMatcher = new PermissionMatcher(user.roles);
  
  // 多个 Requirement 之间是 AND 关系
  return requirements.every(req => {
    if (req.kind === 'permission') {
      // 单个 Requirement 内部是 AND 或 OR
      const hasPermission = req.mode === 'OR'
        ? req.value.some(p => permMatcher.matches(p))
        : req.value.every(p => permMatcher.matches(p));
      
      // 角色兜底：任一角色满足即可
      const hasRole = req.role.length > 0 && req.role.some(r => roleMatcher.matches(r));
      
      return hasPermission || hasRole;
    } else {
      // 角色检查
      return req.mode === 'OR'
        ? req.value.some(r => roleMatcher.matches(r))
        : req.value.every(r => roleMatcher.matches(r));
    }
  });
}
```

#### 7.1.3 策略组合模式

**装饰器驱动的声明式授权**:
```typescript
// 示例 1: 单一权限
@Permission('system:user:view')
async getUser(@Param('id') id: string) { }

// 示例 2: OR 模式
@Permission({ value: ['system:user:add', 'system:user:edit'], mode: Mode.OR })
async saveUser(@Body() dto: UserDto) { }

// 示例 3: 角色兜底
@Permission({ value: 'system:sensitive:view', role: 'admin' })
async getSensitiveData() { }

// 示例 4: 多个装饰器（AND 组合）
@Permission('system:order:view')
@Permission({ value: 'finance:report:view', role: 'finance_manager' })
async getOrderReport() { }

// 示例 5: 仅登录即可
@Authenticated()
async getProfile() { }
```

**守卫执行顺序**:
```typescript
@Injectable()
export class PermissionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;  // 已由 AuthGuard 注入
    
    if (!user) throw new UnauthorizedException();
    
    // 1. 收集类和方法上的所有 Requirement
    const classReqs = this.reflector.get(ACCESS_REQUIREMENTS, context.getClass()) ?? [];
    const methodReqs = this.reflector.get(ACCESS_REQUIREMENTS, context.getHandler()) ?? [];
    const allReqs = [...classReqs, ...methodReqs];
    
    // 2. 检查 @Authenticated() 标记
    const needAuth = this.reflector.getAllAndOverride(AUTHENTICATED_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    
    // 3. 无要求且无 @Authenticated 标记 → 拒绝（默认拒绝）
    if (allReqs.length === 0 && !needAuth) {
      throw new ForbiddenException('该接口未配置权限要求');
    }
    
    // 4. 仅 @Authenticated 无其他要求 → 放行
    if (allReqs.length === 0 && needAuth) {
      return true;
    }
    
    // 5. 评估权限要求
    const allowed = evaluateRequirements(user, allReqs);
    if (!allowed) {
      throw new ForbiddenException('权限不足');
    }
    
    return true;
  }
}
```

### 7.2 ABAC 扩展（属性基础访问控制）

#### 7.2.1 条件约束设计

```typescript
/**
 * 权限约束条件（存储在 role_permission.constraints）
 */
interface PermissionConstraints {
  // 时间约束
  timeWindow?: {
    startTime: string;  // "09:00"
    endTime: string;    // "18:00"
    weekdays?: number[]; // [1,2,3,4,5] (周一到周五)
  };
  
  // IP 白名单
  ipWhitelist?: string[];
  
  // 数据范围约束
  dataScope?: {
    onlyOwned?: boolean;      // 只能访问自己创建的
    deptRestriction?: string; // SELF/DEPT/DEPT_AND_CHILD
  };
  
  // 操作限制
  rateLimit?: {
    maxRequests: number;
    windowSeconds: number;
  };
  
  // 审批要求
  requireApproval?: {
    threshold?: number;  // 超过此金额需要审批
    approverRole: string;
  };
}

/**
 * 约束评估器
 */
class ConstraintEvaluator {
  evaluate(
    constraints: PermissionConstraints,
    context: RequestContext
  ): { allowed: boolean; reason?: string } {
    // 1. 时间窗口检查
    if (constraints.timeWindow) {
      const now = new Date();
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      const currentWeekday = now.getDay();
      
      if (currentTime < constraints.timeWindow.startTime || 
          currentTime > constraints.timeWindow.endTime) {
        return { allowed: false, reason: '不在允许的时间窗口内' };
      }
      
      if (constraints.timeWindow.weekdays && 
          !constraints.timeWindow.weekdays.includes(currentWeekday)) {
        return { allowed: false, reason: '不在允许的工作日内' };
      }
    }
    
    // 2. IP 白名单检查
    if (constraints.ipWhitelist && 
        !constraints.ipWhitelist.includes(context.ipAddress)) {
      return { allowed: false, reason: 'IP 地址不在白名单内' };
    }
    
    // 3. 速率限制检查
    if (constraints.rateLimit) {
      const key = `ratelimit:${context.userId}:${context.permission}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, constraints.rateLimit.windowSeconds);
      }
      if (count > constraints.rateLimit.maxRequests) {
        return { allowed: false, reason: '超出速率限制' };
      }
    }
    
    return { allowed: true };
  }
}
```

#### 7.2.2 资源所有权检查

```typescript
/**
 * 资源访问控制（结合 RBAC + ABAC）
 */
@Injectable()
export class ResourceAccessControl {
  async canAccess(
    user: AuthenticatedUser,
    resourceType: string,
    resourceId: string,
    action: 'READ' | 'UPDATE' | 'DELETE'
  ): Promise<boolean> {
    // 1. 检查基础功能权限
    const permission = `${resourceType}:${action.toLowerCase()}`;
    if (!this.permissions.checkPermission(user, permission)) {
      return false;
    }
    
    // 2. 加载资源
    const resource = await this.loadResource(resourceType, resourceId);
    if (!resource) return false;
    
    // 3. 检查数据权限策略
    const dataPerms = await db.dataPermission.findMany({
      where: {
        roleId: { in: user.roles.map(r => this.getRoleId(r)) },
        resourceType,
      },
    });
    
    for (const dataPerm of dataPerms) {
      // 检查操作是否允许
      if (!dataPerm.allowedActions.includes(action)) continue;
      
      // 检查范围
      switch (dataPerm.scopeType) {
        case 'ALL':
          return true;
        
        case 'SELF':
          if (resource.userId === user.userId) return true;
          break;
        
        case 'DEPT':
          if (resource.deptId === user.deptId) return true;
          break;
        
        case 'DEPT_AND_CHILD':
          const deptScope = await this.loadDataScope(user);
          if (deptScope.deptIds.includes(resource.deptId)) return true;
          break;
        
        case 'CUSTOM':
          // 评估自定义条件
          if (this.evaluateCustomScope(dataPerm.scopeConfig, resource, user)) {
            return true;
          }
          break;
        
        case 'CREATOR':
          if (resource.createdBy === user.userId) return true;
          break;
      }
    }
    
    return false;
  }
  
  private evaluateCustomScope(
    config: any,
    resource: any,
    user: AuthenticatedUser
  ): boolean {
    // 示例：{"dept_ids": [1,2,3], "status": "APPROVED"}
    if (config.dept_ids && !config.dept_ids.includes(resource.deptId)) {
      return false;
    }
    if (config.status && resource.status !== config.status) {
      return false;
    }
    return true;
  }
}
```

---

## 8. 数据权限（Data Scope）架构

### 8.1 数据范围计算引擎

#### 8.1.1 核心接口设计

```typescript
/**
 * 数据范围过滤器
 */
interface DataScopeFilter {
  kind: 'all' | 'none' | 'limited';
  deptIds?: string[];
  selfUserId?: string;
  customConditions?: Record<string, any>;
}

/**
 * 数据权限服务
 */
@Injectable()
export class DataScopeService {
  /**
   * 加载用户的数据范围
   */
  async loadDataScope(
    user: AuthenticatedUser,
    resourceType?: string
  ): Promise<DataScopeFilter> {
    // 1. 超管不受限
    if (this.isSuperAdmin(user.userId)) {
      return { kind: 'all' };
    }
    
    // 2. 加载用户角色的数据权限配置
    const dataPerms = await this.getDataPermissions(user, resourceType);
    
    if (dataPerms.length === 0) {
      return { kind: 'none' };
    }
    
    // 3. 合并多个角色的数据范围（取并集）
    const merged = await this.mergeDataScopes(user, dataPerms);
    
    return merged;
  }
  
  /**
   * 将数据范围注入到 Prisma 查询条件
   */
  withDataScope<T>(
    where: T,
    filter: DataScopeFilter,
    columns: { dept?: string; self?: string }
  ): T {
    if (filter.kind === 'all') return where;
    
    const branches: any[] = [];
    
    if (filter.kind === 'limited') {
      // 部门分支
      if (columns.dept && filter.deptIds && filter.deptIds.length > 0) {
        branches.push({
          [columns.dept]: {
            in: filter.deptIds.map(id => BigInt(id)),
          },
        });
      }
      
      // 本人分支
      if (columns.self && filter.selfUserId) {
        branches.push({
          [columns.self]: BigInt(filter.selfUserId),
        });
      }
    }
    
    // 空范围：生成恒假条件
    if (branches.length === 0) {
      const col = columns.dept ?? columns.self;
      if (!col) throw new Error('缺少数据范围归属列');
      return {
        AND: [where, { [col]: { in: [] } }],
      } as T;
    }
    
    // 组合条件
    return {
      AND: [
        where,
        branches.length === 1 ? branches[0] : { OR: branches },
      ],
    } as T;
  }
  
  /**
   * 合并多个角色的数据范围
   */
  private async mergeDataScopes(
    user: AuthenticatedUser,
    dataPerms: DataPermission[]
  ): Promise<DataScopeFilter> {
    const allDeptIds = new Set<string>();
    let includeSelf = false;
    
    for (const perm of dataPerms) {
      switch (perm.scopeType) {
        case 'ALL':
          return { kind: 'all' };  // 任一角色全部数据即全部放行
        
        case 'DEPT':
          if (user.deptId) allDeptIds.add(user.deptId);
          break;
        
        case 'DEPT_AND_CHILD':
          if (user.deptId) {
            const children = await this.getDeptChildren(user.deptId);
            children.forEach(id => allDeptIds.add(id));
          }
          break;
        
        case 'SELF':
          includeSelf = true;
          break;
        
        case 'CUSTOM':
          const customDepts = perm.scopeConfig?.dept_ids ?? [];
          customDepts.forEach((id: string) => allDeptIds.add(id));
          break;
      }
    }
    
    if (allDeptIds.size === 0 && !includeSelf) {
      return { kind: 'none' };
    }
    
    return {
      kind: 'limited',
      deptIds: Array.from(allDeptIds),
      selfUserId: includeSelf ? user.userId : undefined,
    };
  }
  
  /**
   * 获取部门子树（使用物化路径）
   */
  private async getDeptChildren(deptId: string): Promise<string[]> {
    const rows = await db.dept.findMany({
      where: {
        ancestors: { contains: `/${deptId}/` },
        status: '0',
        deletedAt: null,
      },
      select: { deptId: true },
    });
    return rows.map(r => String(r.deptId));
  }
}
```

#### 8.1.2 性能优化：数据范围缓存

```typescript
/**
 * 数据范围缓存（短期缓存，避免重复查询）
 */
@Injectable()
export class DataScopeCacheService {
  private readonly CACHE_TTL = 60;  // 60秒
  
  async getCachedDataScope(
    userId: string,
    resourceType: string
  ): Promise<DataScopeFilter | null> {
    const key = `datascope:${userId}:${resourceType}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }
  
  async setCachedDataScope(
    userId: string,
    resourceType: string,
    filter: DataScopeFilter
  ): Promise<void> {
    const key = `datascope:${userId}:${resourceType}`;
    await redis.set(key, JSON.stringify(filter), 'EX', this.CACHE_TTL);
  }
  
  /**
   * 权限变更后清除缓存
   */
  async invalidateUserCache(userId: string): Promise<void> {
    const pattern = `datascope:${userId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
```

### 8.2 字段级权限控制

#### 8.2.1 响应拦截器实现

```typescript
/**
 * 字段脱敏/过滤拦截器
 */
@Injectable()
export class FieldPermissionInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly fieldPermService: FieldPermissionService,
  ) {}
  
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;
    
    return next.handle().pipe(
      map(data => {
        // 获取资源类型（从装饰器）
        const resourceType = this.reflector.get<string>('resourceType', context.getHandler());
        if (!resourceType || !user) return data;
        
        // 获取字段权限配置
        const fieldPerm = this.fieldPermService.getFieldPermission(user, resourceType);
        
        // 递归处理数据
        return this.applyFieldPermission(data, fieldPerm);
      }),
    );
  }
  
  private applyFieldPermission(data: any, perm: FieldPermission): any {
    if (!data) return data;
    
    if (Array.isArray(data)) {
      return data.map(item => this.applyFieldPermission(item, perm));
    }
    
    if (typeof data === 'object') {
      const result: any = {};
      
      for (const [key, value] of Object.entries(data)) {
        // 1. 检查字段是否在白名单（如果有白名单）
        if (perm.allowedFields && !perm.allowedFields.includes(key)) {
          continue;  // 跳过不在白名单的字段
        }
        
        // 2. 检查是否需要脱敏
        if (perm.maskedFields?.includes(key)) {
          result[key] = this.maskValue(value, key);
        } else {
          result[key] = this.applyFieldPermission(value, perm);
        }
      }
      
      return result;
    }
    
    return data;
  }
  
  private maskValue(value: any, fieldName: string): any {
    if (typeof value !== 'string') return value;
    
    // 根据字段类型选择脱敏策略
    if (fieldName.includes('phone') || fieldName.includes('mobile')) {
      // 手机号: 138****5678
      return value.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
    }
    
    if (fieldName.includes('email')) {
      // 邮箱: a***@example.com
      return value.replace(/(.{1}).*(@.*)/, '$1***$2');
    }
    
    if (fieldName.includes('idCard')) {
      // 身份证: 110***********1234
      return value.replace(/(.{3}).*(.{4})/, '$1***********$2');
    }
    
    // 默认: 只显示前后各2个字符
    if (value.length > 4) {
      return value.slice(0, 2) + '***' + value.slice(-2);
    }
    
    return '***';
  }
}

/**
 * 使用示例
 */
@Controller('users')
@UseInterceptors(FieldPermissionInterceptor)
export class UserController {
  @Get(':id')
  @SetMetadata('resourceType', 'USER')
  async getUser(@Param('id') id: string) {
    // 返回的数据会自动经过字段权限过滤
    return this.userService.findOne(id);
  }
}
```

---

## 9. 菜单权限架构

### 9.1 前后端分离的菜单设计

#### 9.1.1 菜单数据结构

**后端菜单实体**（专注于权限控制）:
```typescript
interface MenuEntity {
  menuId: string;
  parentId: string;
  menuName: string;
  menuType: 'M' | 'C' | 'L';  // 目录/菜单/外链
  
  // 权限关联
  permissionId?: string;
  permissionCode?: string;  // 冗余字段，方便前端判断
  
  // 路由信息（前端使用）
  routePath?: string;
  componentPath?: string;
  
  // 显示控制
  icon?: string;
  orderNum: number;
  isVisible: boolean;
  
  // 元数据
  metadata?: Record<string, any>;
}
```

**前端路由配置**（可独立扩展）:
```typescript
interface RouteConfig {
  path: string;
  name: string;
  component: () => Promise<any>;
  
  meta: {
    title: string;
    icon?: string;
    permission?: string;  // 关联后端权限码
    roles?: string[];     // 或直接指定角色
    
    // 前端特有配置
    keepAlive?: boolean;
    hidden?: boolean;
    affix?: boolean;
    badge?: string;
  };
  
  children?: RouteConfig[];
}
```

#### 9.1.2 菜单权限过滤

**服务端过滤**（返回用户可访问的菜单树）:
```typescript
@Injectable()
export class MenuService {
  /**
   * 获取用户的菜单树（已过滤权限）
   */
  async getUserMenus(user: AuthenticatedUser): Promise<MenuTreeNode[]> {
    // 1. 超管获取全部菜单
    if (this.isSuperAdmin(user.userId)) {
      return this.getAllMenus();
    }
    
    // 2. 普通用户：通过角色获取菜单
    const menus = await db.menu.findMany({
      where: {
        status: '0',
        isVisible: true,
        // 通过角色关联查询
        OR: [
          // 无需权限的公共菜单
          { permissionId: null },
          // 用户角色关联的菜单
          {
            permission: {
              roles: {
                some: {
                  roleId: {
                    in: user.roles.map(r => this.getRoleId(r)),
                  },
                },
              },
            },
          },
        ],
      },
      include: {
        permission: {
          select: { permissionCode: true },
        },
      },
      orderBy: [{ orderNum: 'asc' }, { menuId: 'asc' }],
    });
    
    // 3. 构建树结构
    return this.buildMenuTree(menus);
  }
  
  /**
   * 构建菜单树（递归）
   */
  private buildMenuTree(
    menus: MenuEntity[],
    parentId: string = '0'
  ): MenuTreeNode[] {
    const result: MenuTreeNode[] = [];
    
    for (const menu of menus) {
      if (menu.parentId !== parentId) continue;
      
      const children = this.buildMenuTree(menus, menu.menuId);
      
      result.push({
        ...menu,
        children: children.length > 0 ? children : undefined,
      });
    }
    
    return result;
  }
}
```

**前端路由守卫**（二次校验）:
```typescript
/**
 * Vue Router 全局前置守卫
 */
router.beforeEach(async (to, from, next) => {
  const userStore = useUserStore();
  
  // 1. 检查是否需要登录
  if (to.meta.requireAuth && !userStore.isAuthenticated) {
    return next({ name: 'Login', query: { redirect: to.fullPath } });
  }
  
  // 2. 检查权限
  if (to.meta.permission) {
    const hasPermission = userStore.permissions.includes(to.meta.permission);
    if (!hasPermission) {
      return next({ name: 'Forbidden' });
    }
  }
  
  // 3. 检查角色
  if (to.meta.roles) {
    const hasRole = to.meta.roles.some(role => userStore.roles.includes(role));
    if (!hasRole) {
      return next({ name: 'Forbidden' });
    }
  }
  
  next();
});
```

### 9.2 动态路由加载

```typescript
/**
 * 根据后端菜单动态生成前端路由
 */
export class DynamicRouteService {
  /**
   * 将后端菜单转换为前端路由
   */
  async generateRoutes(menus: MenuTreeNode[]): Promise<RouteConfig[]> {
    const routes: RouteConfig[] = [];
    
    for (const menu of menus) {
      const route = await this.menuToRoute(menu);
      if (route) {
        routes.push(route);
      }
    }
    
    return routes;
  }
  
  private async menuToRoute(menu: MenuTreeNode): Promise<RouteConfig | null> {
    // 跳过隐藏菜单
    if (!menu.isVisible) return null;
    
    // 基础路由配置
    const route: RouteConfig = {
      path: menu.routePath || `/${menu.menuId}`,
      name: this.generateRouteName(menu),
      component: await this.loadComponent(menu),
      meta: {
        title: menu.menuName,
        icon: menu.icon,
        permission: menu.permissionCode,
        menuId: menu.menuId,
      },
    };
    
    // 递归处理子菜单
    if (menu.children && menu.children.length > 0) {
      route.children = [];
      for (const child of menu.children) {
        const childRoute = await this.menuToRoute(child);
        if (childRoute) {
          route.children.push(childRoute);
        }
      }
    }
    
    return route;
  }
  
  /**
   * 动态加载组件
   */
  private async loadComponent(menu: MenuTreeNode): Promise<() => Promise<any>> {
    if (menu.menuType === 'L') {
      // 外链：使用 iframe 容器
      return () => import('@/views/system/iframe/index.vue');
    }
    
    if (menu.menuType === 'M') {
      // 目录：使用布局组件
      return () => import('@/layouts/default/index.vue');
    }
    
    // 菜单：动态导入组件
    const componentPath = menu.componentPath || `@/views${menu.routePath}/index.vue`;
    
    try {
      return () => import(/* @vite-ignore */ componentPath);
    } catch {
      // 组件不存在时使用 404 页面
      return () => import('@/views/system/error/404.vue');
    }
  }
}
```

---

## 10. 会话管理架构

### 10.1 分布式会话同步

#### 10.1.1 Redis 主从架构

```yaml
# Redis 集群配置
redis-cluster:
  - master: redis-1.example.com:6379
    replicas:
      - redis-1-replica-1.example.com:6379
      - redis-1-replica-2.example.com:6379
  
  - master: redis-2.example.com:6379
    replicas:
      - redis-2-replica-1.example.com:6379
      - redis-2-replica-2.example.com:6379

# 读写分离
read-preference: replica-preferred
write-concern: majority
```

#### 10.1.2 会话故障转移

```typescript
@Injectable()
export class ResilientSessionStore {
  constructor(
    private readonly redisCluster: RedisCluster,
    private readonly dbBackup: PrismaService,
  ) {}
  
  /**
   * 带降级的会话读取
   */
  async getSession(sessionId: string): Promise<Session | null> {
    try {
      // 1. 尝试从 Redis 读取
      const cached = await this.redisCluster.get(`session:${sessionId}`);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn('Redis read failed, falling back to database', { sessionId, error });
    }
    
    try {
      // 2. Redis 故障时从数据库读取
      const backup = await this.dbBackup.sessionSnapshot.findUnique({
        where: { sessionId },
      });
      
      if (backup && backup.expiresAt > new Date()) {
        // 尝试回填到 Redis（非阻塞）
        this.backfillRedis(sessionId, backup).catch(() => {});
        
        return {
          userId: backup.userId,
          refreshHash: backup.refreshHash,
          expiresAt: backup.expiresAt.getTime(),
          ...backup.snapshotData,
        };
      }
    } catch (error) {
      logger.error('Database backup read failed', { sessionId, error });
    }
    
    return null;
  }
  
  private async backfillRedis(sessionId: string, backup: any): Promise<void> {
    const ttl = Math.floor((backup.expiresAt.getTime() - Date.now()) / 1000);
    if (ttl > 0) {
      await this.redisCluster.set(
        `session:${sessionId}`,
        JSON.stringify(backup.snapshotData),
        'EX',
        ttl,
      );
    }
  }
}
```

---

## 11. 性能优化策略

### 11.1 权限校验性能优化

#### 11.1.1 权限快照预计算

**问题**: 每次请求都计算权限会导致大量数据库查询

**解决方案**: 登录时预计算并缓存
```typescript
// 权限快照结构（已优化）
interface OptimizedAuthSnapshot {
  roles: string[];              // ["admin", "user"]
  permissions: string[];        // ["system:user:*", "order:view"]
  
  // 预编译的匹配器（序列化存储）
  exactPermissions: string[];   // 精确权限集合
  wildcardPatterns: string[];   // 通配符模式
  
  // 数据权限配置（常用资源类型）
  dataScopes: {
    [resourceType: string]: DataScopeFilter;
  };
}
```

#### 11.1.2 批量权限检查

```typescript
/**
 * 批量检查权限（用于菜单渲染、按钮显示）
 */
@Injectable()
export class BatchPermissionService {
  /**
   * 一次性检查多个权限
   */
  batchCheck(
    user: AuthenticatedUser,
    permissions: string[]
  ): Map<string, boolean> {
    const matcher = new PermissionMatcher(user.permissions);
    const results = new Map<string, boolean>();
    
    // 单次遍历完成所有检查
    for (const perm of permissions) {
      results.set(perm, matcher.matches(perm));
    }
    
    return results;
  }
}

/**
 * 前端使用示例
 */
const permissionResults = await api.batchCheckPermissions([
  'system:user:add',
  'system:user:edit',
  'system:user:delete',
  'system:role:assign',
]);

// 根据结果控制按钮显示
<Button v-if="permissionResults.get('system:user:add')">新增</Button>
```

### 11.2 数据库查询优化

#### 11.2.1 索引策略

```sql
-- 用户角色查询优化
CREATE INDEX CONCURRENTLY idx_user_role_lookup 
ON sys_user_role (user_id, role_id) 
WHERE revoked_at IS NULL;

-- 角色权限查询优化
CREATE INDEX CONCURRENTLY idx_role_perm_lookup
ON sys_role_permission (role_id) 
INCLUDE (permission_id, access_mode);

-- 部门子树查询优化（GIN 索引 + 三元组）
CREATE INDEX CONCURRENTLY idx_dept_ancestors_trgm
ON sys_dept USING GIN (ancestors gin_trgm_ops)
WHERE deleted_at IS NULL;

-- 会话查询优化
CREATE INDEX CONCURRENTLY idx_session_user_active
ON sys_session_snapshot (user_id, expires_at)
WHERE expires_at > CURRENT_TIMESTAMP;
```

#### 11.2.2 查询优化示例

**优化前**（N+1 查询）:
```typescript
// ❌ 糟糕的实现
async getUsersWithRoles(): Promise<UserWithRoles[]> {
  const users = await db.user.findMany();
  
  for (const user of users) {
    user.roles = await db.userRole.findMany({
      where: { userId: user.userId },
      include: { role: true },
    });
  }
  
  return users;
}
```

**优化后**（单次联表查询）:
```typescript
// ✅ 优化的实现
async getUsersWithRoles(): Promise<UserWithRoles[]> {
  return db.user.findMany({
    include: {
      roles: {
        include: { role: true },
        where: { revokedAt: null },
      },
    },
    where: { deletedAt: null },
  });
}
```

### 11.3 缓存策略

#### 11.3.1 多层缓存架构

```
┌─────────────────────────────────────────┐
│  L1: Application Memory Cache (LRU)     │
│  - 权限快照 (5分钟)                      │
│  - 用户基本信息 (10分钟)                 │
└───────────────┬─────────────────────────┘
                │ Miss
┌───────────────▼─────────────────────────┐
│  L2: Redis Cache                        │
│  - 会话数据 (30天)                       │
│  - 数据权限范围 (1分钟)                  │
│  - 菜单树 (1小时)                        │
└───────────────┬─────────────────────────┘
                │ Miss
┌───────────────▼─────────────────────────┐
│  L3: PostgreSQL                         │
│  - 权威数据源                            │
└─────────────────────────────────────────┘
```

**实现**:
```typescript
@Injectable()
export class MultiLevelCacheService {
  private readonly l1Cache = new LRUCache<string, any>({
    max: 10000,
    ttl: 300_000,  // 5分钟
  });
  
  async get<T>(
    key: string,
    loader: () => Promise<T>,
    options?: { l1Ttl?: number; l2Ttl?: number }
  ): Promise<T> {
    // L1: Memory
    let value = this.l1Cache.get(key);
    if (value !== undefined) {
      return value as T;
    }
    
    // L2: Redis
    const cached = await redis.get(key);
    if (cached) {
      value = JSON.parse(cached);
      this.l1Cache.set(key, value);
      return value as T;
    }
    
    // L3: Database
    value = await loader();
    
    // 回填缓存
    await redis.set(key, JSON.stringify(value), 'EX', options?.l2Ttl ?? 3600);
    this.l1Cache.set(key, value);
    
    return value;
  }
  
  /**
   * 缓存失效（级联）
   */
  async invalidate(pattern: string): Promise<void> {
    // 清除 L1
    for (const key of this.l1Cache.keys()) {
      if (key.startsWith(pattern)) {
        this.l1Cache.delete(key);
      }
    }
    
    // 清除 L2
    const keys = await redis.keys(`${pattern}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
```

---

## 12. 安全加固方案

### 12.1 防护措施清单

| 威胁类型 | 防护措施 | 实现位置 |
|---------|---------|---------|
| **暴力破解** | 登录失败锁定、验证码、速率限制 | AuthService |
| **会话劫持** | Token 轮换、设备指纹、IP 绑定 | SessionManager |
| **权限提升** | 最小权限、显式授权、审计日志 | PermissionGuard |
| **SQL 注入** | 参数化查询、ORM、输入校验 | Prisma + DTO |
| **CSRF** | SameSite Cookie、Token 验证 | NestJS Guard |
| **XSS** | 内容安全策略、输出转义 | 前端框架 |

### 12.2 安全审计实现

```typescript
/**
 * 敏感操作审计装饰器
 */
export function Auditable(options: {
  action: string;
  resourceType?: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const context = args.find(arg => arg?.user);
      const user = context?.user as AuthenticatedUser;
      
      const auditEntry = {
        actionType: options.action,
        targetType: options.resourceType,
        operatorId: user?.userId,
        operatorIp: context?.ip,
        riskLevel: options.riskLevel || 'LOW',
        beforeState: null,
        afterState: null,
      };
      
      try {
        // 记录操作前状态（高风险操作）
        if (options.riskLevel === 'HIGH' || options.riskLevel === 'CRITICAL') {
          const targetId = args[0];
          auditEntry.beforeState = await captureState(
            options.resourceType,
            targetId
          );
        }
        
        // 执行原方法
        const result = await originalMethod.apply(this, args);
        
        // 记录操作后状态
        if (auditEntry.beforeState) {
          auditEntry.afterState = await captureState(
            options.resourceType,
            args[0]
          );
        }
        
        // 写入审计日志
        await auditLogger.log({
          ...auditEntry,
          status: 'SUCCESS',
        });
        
        return result;
      } catch (error) {
        // 记录失败
        await auditLogger.log({
          ...auditEntry,
          status: 'FAILURE',
          errorMessage: error.message,
        });
        
        throw error;
      }
    };
    
    return descriptor;
  };
}

/**
 * 使用示例
 */
@Injectable()
export class RoleService {
  @Auditable({
    action: 'MODIFY_ROLE_PERMISSIONS',
    resourceType: 'ROLE',
    riskLevel: 'HIGH',
  })
  async assignPermissions(
    roleId: string,
    permissionIds: string[],
    context: RequestContext
  ) {
    // ... 实际的权限分配逻辑
  }
}
```

---

## 13. 实施路线图

### 13.1 分阶段实施计划

#### **阶段 1: 基础重构（2-3 周）**

**目标**: 优化现有数据模型，建立新的权限表结构

**任务**:
1. ✅ 创建新表结构（sys_permission, sys_data_permission, audit_log）
2. ✅ 数据迁移脚本（从 sys_menu.perms 提取到 sys_permission）
3. ✅ 建立双写机制（旧表 + 新表同时写入）
4. ✅ 单元测试覆盖核心逻辑

**交付物**:
- 数据库迁移脚本
- 新旧模型对照文档
- 测试报告

#### **阶段 2: 认证模块升级（2 周）**

**目标**: 强化会话管理，实现Token轮换和多设备管理

**任务**:
1. ✅ 实现 RefreshToken 轮换机制
2. ✅ 添加设备指纹识别
3. ✅ 实现会话审计日志
4. ✅ 数据库备份会话（灾难恢复）

**交付物**:
- 认证流程时序图
- 会话管理API文档
- 性能测试报告

#### **阶段 3: 授权引擎重构（3 周）**

**目标**: 实现统一的权限决策引擎，支持ABAC扩展

**任务**:
1. ✅ 重构 PermissionGuard，支持约束条件
2. ✅ 实现批量权限检查API
3. ✅ 添加字段级权限控制
4. ✅ 集成审计日志

**交付物**:
- 权限决策流程图
- 装饰器使用指南
- 性能基准测试

#### **阶段 4: 数据权限增强（2 周）**

**目标**: 优化数据权限性能，支持更灵活的范围配置

**任务**:
1. ✅ 实现数据范围缓存
2. ✅ 支持自定义数据权限策略
3. ✅ 添加字段脱敏拦截器
4. ✅ 优化部门子树查询

**交付物**:
- 数据权限配置手册
- 性能对比报告
- 使用示例代码

#### **阶段 5: 前端集成（2 周）**

**目标**: 前端动态路由和权限控制集成

**任务**:
1. ✅ 实现动态路由生成
2. ✅ 前端权限指令（v-permission）
3. ✅ 菜单权限过滤
4. ✅ 按钮级权限控制

**交付物**:
- 前端集成文档
- Vue/React 组件库
- 示例项目

#### **阶段 6: 监控与运维（1 周）**

**目标**: 建立监控告警体系

**任务**:
1. ✅ 权限变更监控
2. ✅ 异常登录告警
3. ✅ 性能指标采集
4. ✅ 审计日志分析

**交付物**:
- 监控大盘
- 告警规则文档
- 运维手册

### 13.2 风险控制

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| 数据迁移失败 | 高 | 完整备份 + 灰度迁移 + 回滚脚本 |
| 性能下降 | 中 | 压力测试 + 性能基准 + 缓存预热 |
| 兼容性问题 | 中 | 双写期充分测试 + 渐进式切换 |
| 会话丢失 | 低 | 数据库备份 + Redis 主从 |

### 13.3 回滚策略

**快速回滚方案**:
```sql
-- 1. 切换应用读取旧表
UPDATE sys_config SET config_value = 'legacy' 
WHERE config_key = 'permission_source';

-- 2. 停止新表写入
-- 部署上一个稳定版本

-- 3. 验证数据一致性
SELECT * FROM sys_menu m
LEFT JOIN sys_permission p ON m.perms = p.permission_code
WHERE m.perms IS NOT NULL AND p.permission_id IS NULL;

-- 4. 必要时从备份恢复
-- pg_restore -d dbname backup.dump
```

---

## 14. 测试策略

### 14.1 单元测试

**权限匹配测试**:
```typescript
describe('PermissionMatcher', () => {
  it('应该精确匹配权限', () => {
    const matcher = new PermissionMatcher(['system:user:view']);
    expect(matcher.matches('system:user:view')).toBe(true);
    expect(matcher.matches('system:user:edit')).toBe(false);
  });
  
  it('应该支持通配符匹配', () => {
    const matcher = new PermissionMatcher(['system:user:*']);
    expect(matcher.matches('system:user:view')).toBe(true);
    expect(matcher.matches('system:user:edit')).toBe(true);
    expect(matcher.matches('system:role:view')).toBe(false);
  });
  
  it('应该支持全局通配符', () => {
    const matcher = new PermissionMatcher(['*:*:*']);
    expect(matcher.matches('any:thing:here')).toBe(true);
  });
});
```

### 14.2 集成测试

**权限守卫测试**:
```typescript
describe('PermissionGuard Integration', () => {
  let app: INestApplication;
  
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    
    app = module.createNestApplication();
    await app.init();
  });
  
  it('应该拒绝无权限的访问', async () => {
    const token = await createTestToken({ permissions: [] });
    
    return request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
  
  it('应该允许有权限的访问', async () => {
    const token = await createTestToken({
      permissions: ['system:user:view'],
    });
    
    return request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
```

### 14.3 性能测试

**压力测试脚本** (k6):
```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 100 },   // 上升到 100 并发
    { duration: '5m', target: 100 },   // 保持 100 并发 5 分钟
    { duration: '1m', target: 500 },   // 上升到 500 并发
    { duration: '5m', target: 500 },   // 保持 500 并发
    { duration: '1m', target: 0 },     // 降至 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],  // 95% < 500ms, 99% < 1s
    http_req_failed: ['rate<0.01'],  // 错误率 < 1%
  },
};

export default function () {
  const token = __ENV.TEST_TOKEN;
  
  // 1. 权限检查
  const checkRes = http.get('https://api.example.com/api/auth/check', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(checkRes, {
    '权限检查 < 50ms': (r) => r.timings.duration < 50,
  });
  
  // 2. 数据查询（含数据权限）
  const dataRes = http.get('https://api.example.com/api/users?page=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(dataRes, {
    '数据查询成功': (r) => r.status === 200,
    '查询 < 200ms': (r) => r.timings.duration < 200,
  });
}
```

---

## 15. 运维与监控

### 15.1 关键指标

| 指标 | 阈值 | 告警级别 |
|------|------|---------|
| 权限校验耗时 P99 | < 10ms | Warning |
| 会话创建成功率 | > 99.9% | Critical |
| Redis 可用性 | > 99.95% | Critical |
| 审计日志延迟 | < 1s | Warning |
| 权限变更生效时间 | < 5s | Info |

### 15.2 监控大盘

**Grafana 面板配置**:
```yaml
panels:
  - title: 认证成功率
    query: |
      sum(rate(auth_attempts_total{status="success"}[5m])) /
      sum(rate(auth_attempts_total[5m])) * 100
    
  - title: 权限校验耗时分布
    query: |
      histogram_quantile(0.99, 
        rate(permission_check_duration_bucket[5m])
      )
  
  - title: 活跃会话数
    query: |
      redis_keys{pattern="session:*"}
  
  - title: 异常登录检测
    query: |
      sum(increase(login_anomaly_total[1h])) by (reason)
```

---

## 16. 附录：代码示例

### 16.1 完整的 RBAC 服务示例

参见项目中的实现文件：
- [认证服务](E:\test\nest-vben-admin\nest-admin\libs\auth\src\auth.service.ts)
- [权限守卫](E:\test\nest-vben-admin\nest-admin\libs\permission\src\permission.guard.ts)
- [数据权限](E:\test\nest-vben-admin\nest-admin\libs\permission\src\data-scope.ts)

### 16.2 迁移脚本示例

```sql
-- migration_001_create_permission_tables.sql
BEGIN;

-- 1. 创建权限表
CREATE TABLE sys_permission (
  permission_id BIGSERIAL PRIMARY KEY,
  permission_code VARCHAR(100) NOT NULL,
  permission_name VARCHAR(100) NOT NULL,
  permission_type VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_permission_code UNIQUE (permission_code)
);

-- 2. 从菜单表迁移数据
INSERT INTO sys_permission (permission_code, permission_name, permission_type)
SELECT DISTINCT 
  perms as permission_code,
  perms as permission_name,
  CASE menu_type 
    WHEN 'F' THEN 'BUTTON'
    WHEN 'C' THEN 'MENU'
    ELSE 'API'
  END as permission_type
FROM sys_menu
WHERE perms IS NOT NULL AND perms != '';

-- 3. 建立关联
ALTER TABLE sys_menu ADD COLUMN permission_id BIGINT 
  REFERENCES sys_permission(permission_id);

UPDATE sys_menu m
SET permission_id = p.permission_id
FROM sys_permission p
WHERE m.perms = p.permission_code;

COMMIT;
```

---

## 总结

本文档从企业级系统架构师的视角，系统性地分析了当前 RBAC 实现的优势与不足，并提供了完整的重构方案：

### 核心改进点

1. **数据模型**: 权限与菜单分离，支持更灵活的权限定义
2. **认证机制**: Token 轮换、多设备管理、MFA 支持
3. **授权引擎**: ABAC 扩展、条件约束、批量检查优化
4. **数据权限**: 缓存优化、字段级控制、自定义策略
5. **审计合规**: 完整的操作日志、变更追踪、异常检测
6. **性能优化**: 多层缓存、索引优化、批量操作
7. **高可用**: Redis 集群、数据库备份、降级方案

### 实施建议

- **采用渐进式重构**: 避免"大爆炸"式上线，通过双写期平滑过渡
- **性能基准先行**: 建立性能基准，确保重构不引入性能退化
- **完善测试覆盖**: 核心逻辑测试覆盖率 > 90%，集成测试覆盖关键流程
- **灰度发布**: 先内部用户 → 小范围用户 → 全量上线
- **监控先行**: 在重构前建立监控体系，及时发现问题

### 预期收益

| 维度 | 当前 | 目标 | 提升 |
|------|------|------|------|
| 权限校验耗时 (P99) | ~15ms | < 5ms | 66% ↓ |
| 权限变更生效时间 | 会话过期(30天) | < 5s | 即时 |
| 审计日志完整性 | 部分覆盖 | 100% | - |
| 系统可用性 | 99% | 99.9% | 0.9% ↑ |
| 代码测试覆盖率 | ~60% | > 90% | 30% ↑ |

---

**文档版本**: v1.0  
**最后更新**: 2026-10-23  
**维护者**: 系统架构组
