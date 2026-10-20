import { toDtoList } from '@app/common';
import { paginate, PrismaService } from '@app/database';
import { Injectable } from '@nestjs/common';

import { ResponseUserDto } from './dto/response.dto.js';

import { CreateUserDto, UpdateUserDto } from './dto/user.dto.js';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  create(createUserDto: CreateUserDto) {
    return 'This action adds a new user';
  }

  async findAll() {
    const data = await paginate(this.prisma.user, { page: 1, pageSize: 10 });
    return toDtoList(ResponseUserDto, data);
  }

  findOne(id: number) {
    return `This action returns a #${id} user`;
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
