export interface UserAuthorization {
  /** 当前有效角色的 roleKey，去重并排序。 */
  roles: readonly string[];
  /** 当前有效菜单/按钮的精确权限码，去重并排序。 */
  permissions: readonly string[];
}

/** 每次加载当前用户的一份角色/权限结果，不从 JWT 或客户端读取权限。 */
export abstract class PermissionSource {
  abstract getAuthorization(userId: string): Promise<UserAuthorization>;
}
