export interface UserAuthorization {
  /** 当前有效角色的 roleKey，去重并排序。 */
  roles: readonly string[];
  /** 当前有效菜单/按钮的权限码，去重并排序；可含 `*` 通配。 */
  permissions: readonly string[];
}

/**
 * 从数据库计算一份授权快照。
 *
 * 只在**登录**时调用一次，结果随会话保存；运行期鉴权不再查库。
 * 对应 RuoYi `SysPermissionServiceImpl.getMenuPermission` / `getRolePermission`
 * 在 `SysLoginService.buildLoginUser` 里被调用的时机。
 *
 * 因此任何影响授权的写操作都必须撤销相关用户的会话（`AuthService.revokeUserSessions`），
 * 否则旧快照会一直生效到会话过期。
 */
export abstract class PermissionSource {
  abstract getAuthorization(userId: string): Promise<UserAuthorization>;
}
