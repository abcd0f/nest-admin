# Crypto 模块使用说明

`@app/crypto` 集中提供应用层加密能力，当前包含两类独立功能：

- API 报文加解密：兼容 RuoYi-Vue-Plus `api-decrypt` 的 AES/RSA 格式。
- 密码哈希：使用 Argon2id 保存和验证用户凭据。

API 报文加密只支持 AES 与 RSA，不支持 SM2。密码哈希与 API 加密使用不同算法和密钥体系。

## 模块接入

应用应在配置模块之后导入 `CryptoModule`。本项目的 `AppModule` 已全局导入该模块，业务模块无需重复导入即可注入 `PasswordHashService` 和 `ApiCryptoService`。

API 请求/响应加密依赖 Fastify hooks 在请求体解析前解密密文。导入 `CryptoModule` 后，模块会在 Nest 应用启动阶段自动将 hooks 安装到 Fastify adapter；业务入口无需单独调用安装函数。加密启用时必须使用 Fastify HTTP adapter。

## DTO 字段级加密和解密

`@EncryptField()` 和 `@DecryptField()` 是针对单个 DTO 属性的 class-transformer 装饰器，使用 AES-256-GCM。字段密钥统一从 `@app/common` 的 `FIELD_ENCRYPTION_KEY` 常量读取，无需在每个 DTO 字段上重复传入。它们与 `@ApiEncrypt` 的整包 API 报文加密互相独立：`@ApiEncrypt` 不会触发字段转换，也不会改变字段加密算法。

### DTO 声明

同一个字段同时标记两个装饰器时，入站密文在 `plainToInstance` 阶段解密，DTO 输出到普通对象时在 `instanceToPlain` 阶段加密。密钥常量定义在 `libs/common/src/constants/field-encryption.ts`，统一由 `libs/common/src/constants/index.ts` 导出。

```ts
import { DecryptField, EncryptField } from '@app/crypto';
import { Expose } from 'class-transformer';

export class UserDto {
  @Expose()
  @EncryptField()
  @DecryptField()
  phoneNumber!: string;
}
```

`EncryptField` 和 `DecryptField` 也可以单独使用：只需写出密文时使用 `@EncryptField`；只需接收并还原密文时使用 `@DecryptField`。

### 请求入参解密

装饰器在 `plainToInstance` 时执行。Nest 的 `@Body()` 默认不会自动将请求对象转换成此 DTO，因此需要显式转换，或在项目的验证管道中启用对应的 class-transformer 转换：

```ts
import { plainToInstance } from 'class-transformer';

@Post()
create(@Body() body: Record<string, unknown>) {
  const dto = plainToInstance(UserDto, body);
  return this.userService.create(dto);
}
```

如果客户端提交 `phoneNumber` 的字段密文，转换后的 `dto.phoneNumber` 是明文，可继续交给业务逻辑处理。客户端提交明文时，`@DecryptField` 会原样保留该值；需要强制只接受密文时，应另外增加格式校验。

### 响应出参加密

响应中返回 DTO 实例时，项目的统一响应拦截器会调用 `instanceToPlain`，因此 `@EncryptField` 会在 JSON 响应序列化前执行：

```ts
@Get(':id')
async findOne(@Param('id') id: string) {
  const user = await this.userService.findOne(id);
  return plainToInstance(UserDto, user);
}
```

转换后的 JSON 中 `phoneNumber` 为密文。若在拦截器外自行构造响应，需手动调用 `instanceToPlain(dto)` 才会触发 `@EncryptField`。

### 密文格式与行为

密文格式如下，nonce、认证标签和密文正文均为 Base64：

```text
enc:v1:<nonce>:<tag>:<ciphertext>
```

每次加密都会生成新的随机 12 字节 nonce；AES-GCM 使用 16 字节认证标签校验数据完整性。相同明文多次加密会得到不同密文，这是预期行为。`@EncryptField` 遇到已有 `enc:v1:` 前缀的值会原样返回，避免重复加密；空值、非字符串值原样保留。`@DecryptField` 遇到没有该前缀的值会原样返回；密钥错误、格式无效或密文被篡改时会抛出错误。

AES-GCM 是可逆加密，不是密码哈希。Argon2 适合密码校验，不能解密还原字段值。不要固定或复用 nonce，也不要把字段密钥与 API 报文中每次请求生成的临时 AES 密钥混用。字段加密也不替代 HTTPS、访问控制或密钥轮换策略。

`FIELD_ENCRYPTION_KEY` 放在源码常量中便于统一引用，但源码常量不是安全的密钥存储：任何能读取构建产物或仓库的人都能取得它。当前常量值仅用于开发默认值；部署生产环境前必须将其替换为通过密钥管理系统注入的密钥，并做好密钥轮换和旧数据迁移安排。

```ts
import { CryptoModule } from '@app/crypto';
import { Module } from '@nestjs/common';

@Module({
  imports: [
    // AppConfigModule.forRoot() 应先于 CryptoModule 初始化。
    CryptoModule,
  ],
})
export class AppModule {}
```

## API AES/RSA 报文加密

### 配置

在本地未入库的 `config/<环境>.local.yaml` 或部署密钥挂载中配置密钥。仓库的 `config/default.yaml` 默认关闭该功能：

```yaml
api-decrypt:
  enabled: true
  header-flag: encrypt-key
  private-key: <RSA PKCS8 私钥 PEM 或 Base64 DER>
  public-key: <RSA SPKI 公钥 PEM 或 Base64 DER>
```

`private-key` 用于解密客户端请求头中的临时 AES 密钥；`public-key` 用于加密服务端响应时的临时 AES 密钥。启用配置时，公钥和私钥都必须存在，但可以来自不同密钥对：请求私钥须与客户端加密公钥配对，响应公钥须与客户端解密私钥配对。密钥不得提交到版本库或记录到日志中。生产环境应通过密钥管理系统或受保护的部署配置注入。

### 控制器用法

从 `@app/crypto` 导入 `ApiEncrypt`。该装饰器按方法设置策略：

```ts
import { ApiEncrypt } from '@app/crypto';
import { Body, Controller, Post } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Post()
  @ApiEncrypt()
  create(@Body() body: CreateUserDto) {
    return this.usersService.create(body);
  }

  @Post('secure-result')
  @ApiEncrypt({ response: true })
  secureResult(@Body() body: SecureRequestDto) {
    return this.usersService.process(body);
  }
}
```

- `@ApiEncrypt()` 要求该方法的 `POST` / `PUT` 请求携带配置的加密头。缺少头时返回 `403`。
- `@ApiEncrypt({ response: true })` 同时启用上述请求要求，并加密该路由的响应正文。响应加密策略也作用于该路由产生的统一异常响应。
- `GET`、`DELETE` 等非 `POST` / `PUT` 方法不会被 Guard 要求加密请求体；响应加密仍可通过 `response: true` 显式启用。
- 未标注 `@ApiEncrypt` 的路由不强制加密。如果 `POST` / `PUT` 请求实际携带了加密头，网关会尝试解密其请求体。
- `api-decrypt.enabled: false` 时，Guard 和 Fastify 加解密 hooks 均不执行；装饰器不会单独启用加密。

### 请求报文

客户端按以下步骤构造加密请求：

1. 生成随机的 16、24 或 32 字节 AES 密钥。
2. 用 AES-ECB 和 PKCS 填充加密 UTF-8 JSON 请求正文，将密文编码为 Base64 文本。
3. 将 AES 密钥原始字节编码为 Base64 文本，再用服务端 RSA 公钥按 PKCS#1 v1.5 填充加密，并将结果编码为 Base64。
4. 将 RSA 密文放入 `encrypt-key` 请求头（或配置的 `header-flag`），请求正文只放 AES 密文 Base64 文本。

示例请求形态：

```http
POST /api/users HTTP/1.1
Content-Type: text/plain
encrypt-key: <Base64 RSA 密文>

<Base64 AES 密文>
```

网关先解密请求体，再将解密后的内容交给 Fastify JSON parser 和 Nest 控制器。因此明文请求体应是合法 JSON。加密失败或密文格式无效时返回 `400`；请求体超过路由或 Fastify 配置的限制时返回 `413`。

### 加密响应

对于标记了 `@ApiEncrypt({ response: true })` 的路由，网关将可处理的普通响应正文序列化文本使用临时 AES 密钥加密，响应正文为 Base64 密文。RSA 加密后的 AES 密钥放在 `encrypt-key` 响应头中，响应 `Content-Type` 为 `text/plain; charset=utf-8`。跨域客户端可读取该响应头，网关会将其加入 `Access-Control-Expose-Headers`。

客户端使用对应 RSA 私钥解开响应头，得到 Base64 编码的 AES 密钥，再解码密钥并通过 AES-ECB/PKCS 填充解密正文。解密后正文是原始 JSON 文本或该路由返回的文本内容。

当路由启用响应加密时，进入该路由后由统一异常过滤器生成的错误响应也按相同格式加密。请求解析阶段的解密失败发生在路由 Guard 之前，`400` / `413` 错误仍直接返回普通 JSON，不能假设所有错误正文都是密文。

响应加密面向普通文本和 JSON API，不适用于文件下载、流式响应；HTTP `204` 和 `304` 响应不会改写。客户端与服务端应始终通过 HTTPS 通信。

### 加密协议约定

| 项目 | 约定 |
| --- | --- |
| 对称加密 | AES-ECB，PKCS 填充（Node.js `aes-*-ecb` 默认 PKCS 填充） |
| AES 密钥长度 | 16、24 或 32 字节 |
| 非对称加密 | RSA PKCS#1 v1.5 |
| 密文编码 | Base64 |
| 请求头 | 默认 `encrypt-key`，可通过 `api-decrypt.header-flag` 修改 |
| 国密算法 | 不支持 SM2 |

## 密码哈希

通过 `PasswordHashService` 对密码进行 Argon2id 哈希；不要使用 API AES/RSA 密钥哈希密码，也不要将明文密码写入数据库或日志。

```ts
import { PasswordHashService } from '@app/crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CredentialService {
  constructor(private readonly passwordHash: PasswordHashService) {}

  async createCredential(userId: string, password: string): Promise<void> {
    const passwordHash = await this.passwordHash.hashPassword(password);
    await this.repository.save({ userId, passwordHash });
  }

  async verifyCredential(storedHash: string, password: string): Promise<boolean> {
    return this.passwordHash.verifyPassword(storedHash, password);
  }
}
```

`hashPassword(password)` 返回 PHC 格式字符串，其中包含随机 salt 和 Argon2 参数，数据库保存整个字符串即可。当前参数为 Argon2id、`memoryCost: 65536`、`timeCost: 3`、`parallelism: 1`、`hashLength: 32`。验证时直接将数据库中的字符串传给 `verifyPassword(encodedHash, password)`。不要自行复用 salt，也不要截断或拆分 PHC 字符串。

当前仓库尚未将该服务接入具体用户注册或登录流程；业务凭据写入和验证应由对应的业务服务完成。

## 相关代码

- 配置定义：`libs/config/src/domains/api-decrypt.domain.ts`
- API 加密服务：`libs/crypto/src/api-crypto.service.ts`
- `@ApiEncrypt` 装饰器及 Guard：`libs/crypto/src/api-encrypt.decorator.ts`、`libs/crypto/src/api-encrypt.guard.ts`
- Fastify 请求/响应 hooks：`libs/crypto/src/fastify-api-crypto.ts`
- 密码哈希服务：`libs/crypto/src/password-hash.service.ts`
- 网关接线：`apps/gateway/src/main.ts`
