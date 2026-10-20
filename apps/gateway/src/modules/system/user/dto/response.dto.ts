import { DateFormat } from '@app/core';
import { Exclude, Expose } from 'class-transformer';

/** 成功返回内容 */
export class ResponseUserDto {
  /**
   * 用户id
   */
  @Expose()
  userId!: number;

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
  email: string;

  /**
   * 手机号
   */
  @Expose()
  phoneNumber: string;

  /**
   * 性别
   */
  @Expose()
  sex: string;

  /**
   * 密码
   */
  @Exclude()
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
  loginIp: string;

  /**
   * 登录时间
   */
  @DateFormat()
  loginDate: string;

  /**
   * 邮箱
   */
  @Expose()
  createDept: string;

  /**
   * 创建人
   */
  @Expose()
  createBy: string;

  /**
   * 创建时间
   */
  @DateFormat()
  createTime: string;

  /**
   * 更新人
   */
  @Expose()
  updateBy: string;

  /**
   * 更新时间
   */
  @DateFormat()
  updateTime: string;

  /**
   * 备注
   */
  @Expose()
  remark: string;
}
