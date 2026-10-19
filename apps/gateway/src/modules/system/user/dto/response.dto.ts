import { PartialType } from '@nestjs/swagger';
import { CreateUserDto } from './user.dto.js';

export class UpdateUserDto extends PartialType(CreateUserDto) {}
