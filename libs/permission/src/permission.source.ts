/** 阶段 3 通过此边界接入当前用户的角色/菜单查询，不从 JWT 或客户端读取权限。 */
export abstract class PermissionSource {
  abstract getPermissions(userId: string): Promise<readonly string[]>;
  abstract getRoles(userId: string): Promise<readonly string[]>;
}

/** 角色/权限加载接入前均返回空列表，不提供管理员或通配符隐式放行。 */
export class DenyPermissionSource extends PermissionSource {
  async getPermissions(_userId: string): Promise<readonly string[]> {
    return [];
  }

  async getRoles(_userId: string): Promise<readonly string[]> {
    return [];
  }
}
