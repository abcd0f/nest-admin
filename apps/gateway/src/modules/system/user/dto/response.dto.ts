import { DateFormat } from '@app/core';
import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';

/** 成功返回内容 */
export class ResponseUserDto {
  /**
   * 用户id
   */
  @Expose()
  @Type(() => String)
  userId!: string;

  /**
   * 用户名称
   */
  @Expose()
  userName: string;

  /**
   * 用户昵称
   */
  @Expose()
  nickName: string;

  /**
   * 邮箱
   */
  @Expose()
  email: string | null;

  /**
   * 手机号
   */
  @Expose()
  phoneNumber: string | null;

  /**
   * 性别
   */
  @Expose()
  sex: string;

  /**
   * 密码
   */
  @Exclude()
  @ApiHideProperty()
  password: string;

  /**
   * 启用状态
   */
  @Expose()
  status: string;

  /**
   * 删除标志
   */
  @Expose()
  delFlag: string;

  /**
   * 登录ip
   */
  @Expose()
  loginIp: string | null;

  /**
   * 登录时间
   */
  @Expose()
  @DateFormat(undefined, { toClassOnly: true })
  loginDate: string | null;

  /**
   * 邮箱
   */
  @Expose()
  createDept?: string;

  /**
   * 创建人
   */
  @Expose()
  @Type(() => String)
  createBy: string | null;

  /**
   * 创建时间，在转入 DTO 时格式化，避免输出 JSON 时再次按服务器时区解析。
   */
  @Expose()
  @DateFormat(undefined, { toClassOnly: true })
  createTime: string;

  /**
   * 更新人
   */
  @Expose()
  @Type(() => String)
  updateBy: string | null;

  /**
   * 更新时间
   */
  @Expose()
  @DateFormat(undefined, { toClassOnly: true })
  updateTime: string | null;

  /**
   * 备注
   */
  @Expose()
  remark: string | null;
}
