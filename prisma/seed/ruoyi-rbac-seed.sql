-- ============================================================
-- RuoYi-Vue-Plus 5.X RBAC 种子数据（PostgreSQL）
--
-- 来源：RuoYi-Vue-Plus-5.X/script/sql/postgres/postgres_ry_vue_5.X.sql
-- 已按 nest-admin 的 Prisma schema 改写：
--   * 删除 tenant_id、create_dept、user_type、avatar、dept_category、
--     create_by/update_by、sys_dept.phone/email、sys_post.post_category
--   * role_sort / post_sort → order_num，leader → leader_id，query_param → query
--   * sys_dept.ancestors 由 "0,100,101" 转为 "/100/101/"（含自身，与 DeptService 一致）
--   * sys_user.password 由 BCrypt 换成 Argon2id（参数与 PasswordHashService 相同）
--   * 菜单只保留「系统管理」下已实现的子树：用户/角色/菜单/部门/岗位，
--     以及分配用户、分配角色两个隐藏页；字典/参数/公告/日志/文件/客户端/监控/
--     工具/租户 全部剔除（本服务没有对应接口）
--
-- 账号：admin / admin123，test / 666666，test1 / 666666
-- 1 号用户是超级管理员（userId == 1 短路为 superadmin + :*:*）
--
-- 用法：psql -h <host> -U <user> -d <db> -f prisma/seed/ruoyi-rbac-seed.sql
--       或在 DataGrip / DBeaver 里整段执行。可重复执行（ON CONFLICT DO NOTHING）。
-- ============================================================

BEGIN;

-- 部门（10 行）：ancestors 已转成 /父/.../自身/ 格式
INSERT INTO sys_dept (dept_id, parent_id, ancestors, dept_name, order_num, leader_id, status, del_flag, create_time) VALUES
    (100, 0, '/100/', 'XXX科技', 0, null, '0', '0', now()),
    (101, 100, '/100/101/', '深圳总公司', 1, null, '0', '0', now()),
    (102, 100, '/100/102/', '长沙分公司', 2, null, '0', '0', now()),
    (103, 101, '/100/101/103/', '研发部门', 1, 1, '0', '0', now()),
    (104, 101, '/100/101/104/', '市场部门', 2, null, '0', '0', now()),
    (105, 101, '/100/101/105/', '测试部门', 3, null, '0', '0', now()),
    (106, 101, '/100/101/106/', '财务部门', 4, null, '0', '0', now()),
    (107, 101, '/100/101/107/', '运维部门', 5, null, '0', '0', now()),
    (108, 102, '/100/102/108/', '市场部门', 1, null, '0', '0', now()),
    (109, 102, '/100/102/109/', '财务部门', 2, null, '0', '0', now())
ON CONFLICT (dept_id) DO NOTHING;

-- 岗位（4 行）：post_sort → order_num，丢弃 post_category
INSERT INTO sys_post (post_id, dept_id, post_code, post_name, order_num, status, create_time, remark) VALUES
    (1, 103, 'ceo', '董事长', 1, '0', now(), ''),
    (2, 100, 'se', '项目经理', 2, '0', now(), ''),
    (3, 100, 'hr', '人力资源', 3, '0', now(), ''),
    (4, 100, 'user', '普通员工', 4, '0', now(), '')
ON CONFLICT (post_id) DO NOTHING;

-- 菜单（33 行）：只保留系统管理下已实现的子树，query_param → query
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, query, is_frame, is_cache, menu_type, visible, status, perms, icon, create_time, remark) VALUES
    (1, '系统管理', 0, '1', 'system', null, '', '1', '0', 'M', '0', '0', '', 'system', now(), '系统管理目录'),
    (100, '用户管理', 1, '1', 'user', 'system/user/index', '', '1', '0', 'C', '0', '0', 'system:user:list', 'user', now(), '用户管理菜单'),
    (101, '角色管理', 1, '2', 'role', 'system/role/index', '', '1', '0', 'C', '0', '0', 'system:role:list', 'peoples', now(), '角色管理菜单'),
    (102, '菜单管理', 1, '3', 'menu', 'system/menu/index', '', '1', '0', 'C', '0', '0', 'system:menu:list', 'tree-table', now(), '菜单管理菜单'),
    (103, '部门管理', 1, '4', 'dept', 'system/dept/index', '', '1', '0', 'C', '0', '0', 'system:dept:list', 'tree', now(), '部门管理菜单'),
    (104, '岗位管理', 1, '5', 'post', 'system/post/index', '', '1', '0', 'C', '0', '0', 'system:post:list', 'post', now(), '岗位管理菜单'),
    (130, '分配用户', 1, '2', 'role-auth/user/:roleId', 'system/role/authUser', '', '1', '1', 'C', '1', '0', 'system:role:edit', '#', now(), '/system/role'),
    (131, '分配角色', 1, '1', 'user-auth/role/:userId', 'system/user/authRole', '', '1', '1', 'C', '1', '0', 'system:user:edit', '#', now(), '/system/user'),
    (1001, '用户查询', 100, '1', '', '', '', '1', '0', 'F', '0', '0', 'system:user:query', '#', now(), ''),
    (1002, '用户新增', 100, '2', '', '', '', '1', '0', 'F', '0', '0', 'system:user:add', '#', now(), ''),
    (1003, '用户修改', 100, '3', '', '', '', '1', '0', 'F', '0', '0', 'system:user:edit', '#', now(), ''),
    (1004, '用户删除', 100, '4', '', '', '', '1', '0', 'F', '0', '0', 'system:user:remove', '#', now(), ''),
    (1005, '用户导出', 100, '5', '', '', '', '1', '0', 'F', '0', '0', 'system:user:export', '#', now(), ''),
    (1006, '用户导入', 100, '6', '', '', '', '1', '0', 'F', '0', '0', 'system:user:import', '#', now(), ''),
    (1007, '重置密码', 100, '7', '', '', '', '1', '0', 'F', '0', '0', 'system:user:resetPwd', '#', now(), ''),
    (1008, '角色查询', 101, '1', '', '', '', '1', '0', 'F', '0', '0', 'system:role:query', '#', now(), ''),
    (1009, '角色新增', 101, '2', '', '', '', '1', '0', 'F', '0', '0', 'system:role:add', '#', now(), ''),
    (1010, '角色修改', 101, '3', '', '', '', '1', '0', 'F', '0', '0', 'system:role:edit', '#', now(), ''),
    (1011, '角色删除', 101, '4', '', '', '', '1', '0', 'F', '0', '0', 'system:role:remove', '#', now(), ''),
    (1012, '角色导出', 101, '5', '', '', '', '1', '0', 'F', '0', '0', 'system:role:export', '#', now(), ''),
    (1013, '菜单查询', 102, '1', '', '', '', '1', '0', 'F', '0', '0', 'system:menu:query', '#', now(), ''),
    (1014, '菜单新增', 102, '2', '', '', '', '1', '0', 'F', '0', '0', 'system:menu:add', '#', now(), ''),
    (1015, '菜单修改', 102, '3', '', '', '', '1', '0', 'F', '0', '0', 'system:menu:edit', '#', now(), ''),
    (1016, '菜单删除', 102, '4', '', '', '', '1', '0', 'F', '0', '0', 'system:menu:remove', '#', now(), ''),
    (1017, '部门查询', 103, '1', '', '', '', '1', '0', 'F', '0', '0', 'system:dept:query', '#', now(), ''),
    (1018, '部门新增', 103, '2', '', '', '', '1', '0', 'F', '0', '0', 'system:dept:add', '#', now(), ''),
    (1019, '部门修改', 103, '3', '', '', '', '1', '0', 'F', '0', '0', 'system:dept:edit', '#', now(), ''),
    (1020, '部门删除', 103, '4', '', '', '', '1', '0', 'F', '0', '0', 'system:dept:remove', '#', now(), ''),
    (1021, '岗位查询', 104, '1', '', '', '', '1', '0', 'F', '0', '0', 'system:post:query', '#', now(), ''),
    (1022, '岗位新增', 104, '2', '', '', '', '1', '0', 'F', '0', '0', 'system:post:add', '#', now(), ''),
    (1023, '岗位修改', 104, '3', '', '', '', '1', '0', 'F', '0', '0', 'system:post:edit', '#', now(), ''),
    (1024, '岗位删除', 104, '4', '', '', '', '1', '0', 'F', '0', '0', 'system:post:remove', '#', now(), ''),
    (1025, '岗位导出', 104, '5', '', '', '', '1', '0', 'F', '0', '0', 'system:post:export', '#', now(), '')
ON CONFLICT (menu_id) DO NOTHING;

-- 角色（3 行）：role_sort → order_num，菜单/部门联动标记转布尔
-- data_scope 用本项目编码：1 全部、2 本部门、3 本部门及以下、4 仅本人、5 自定义
INSERT INTO sys_role (role_id, role_name, role_key, order_num, data_scope, menu_check_strictly, dept_check_strictly, status, del_flag, create_time, remark) VALUES
    (1, '超级管理员', 'superadmin', 1, '1', true, true, '0', '0', now(), '超级管理员'),
    (3, '本部门及以下', 'test1', 3, '3', true, true, '0', '0', now(), ''),
    (4, '仅本人', 'test2', 4, '4', true, true, '0', '0', now(), '')
ON CONFLICT (role_id) DO NOTHING;

-- 用户（3 行）：密码换成 Argon2id，丢弃 tenant_id/user_type/avatar/create_dept
INSERT INTO sys_user (user_id, dept_id, user_name, nick_name, email, phonenumber, sex, password, status, del_flag, login_ip, login_date, create_time, remark) VALUES
    (1, 103, 'admin', '疯狂的狮子Li', 'crazyLionLi@163.com', '15888888888', '1', '$argon2id$v=19$m=65536,p=1,t=3$tMjP7GjWxYZCdJuJVp1dRA$a/QPxMc+kOZJqaQ6W1bASYaT/jRjjY6WYetT8VDd17w', '0', '0', '127.0.0.1', now(), now(), '管理员'),
    (3, 108, 'test', '本部门及以下 密码666666', '', '', '0', '$argon2id$v=19$m=65536,p=1,t=3$dP3aPGQ4YNif96g7OTJhzg$Kyo6psdj9DDqYQ5Vli0EFUpK3sBl0g75q33q3Se3wNE', '0', '0', '127.0.0.1', now(), now(), NULL),
    (4, 102, 'test1', '仅本人 密码666666', '', '', '0', '$argon2id$v=19$m=65536,p=1,t=3$dP3aPGQ4YNif96g7OTJhzg$Kyo6psdj9DDqYQ5Vli0EFUpK3sBl0g75q33q3Se3wNE', '0', '0', '127.0.0.1', now(), now(), NULL)
ON CONFLICT (user_id) DO NOTHING;

-- 用户-角色（3 行）
INSERT INTO sys_user_role (user_id, role_id) VALUES
    (1, 1),
    (3, 3),
    (4, 4)
ON CONFLICT (user_id, role_id) DO NOTHING;

-- 角色-菜单（33 行，已按保留菜单过滤）
INSERT INTO sys_role_menu (role_id, menu_id) VALUES
    (3, 1),
    (3, 100),
    (3, 101),
    (3, 102),
    (3, 103),
    (3, 104),
    (3, 130),
    (3, 131),
    (3, 1001),
    (3, 1002),
    (3, 1003),
    (3, 1004),
    (3, 1005),
    (3, 1006),
    (3, 1007),
    (3, 1008),
    (3, 1009),
    (3, 1010),
    (3, 1011),
    (3, 1012),
    (3, 1013),
    (3, 1014),
    (3, 1015),
    (3, 1016),
    (3, 1017),
    (3, 1018),
    (3, 1019),
    (3, 1020),
    (3, 1021),
    (3, 1022),
    (3, 1023),
    (3, 1024),
    (3, 1025)
ON CONFLICT (role_id, menu_id) DO NOTHING;

-- 用户-岗位（1 行）
INSERT INTO sys_user_post (user_id, post_id) VALUES
    (1, 1)
ON CONFLICT (user_id, post_id) DO NOTHING;

-- 显式插入主键后推进序列，否则自增会从 1 开始撞主键
SELECT setval(pg_get_serial_sequence('sys_dept', 'dept_id'), COALESCE((SELECT MAX(dept_id) FROM sys_dept), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('sys_post', 'post_id'), COALESCE((SELECT MAX(post_id) FROM sys_post), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('sys_menu', 'menu_id'), COALESCE((SELECT MAX(menu_id) FROM sys_menu), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('sys_role', 'role_id'), COALESCE((SELECT MAX(role_id) FROM sys_role), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('sys_user', 'user_id'), COALESCE((SELECT MAX(user_id) FROM sys_user), 0) + 1, false);

COMMIT;
