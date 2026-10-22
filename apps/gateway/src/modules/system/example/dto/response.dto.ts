import { PartialType } from '@nestjs/swagger';
import { CreateExampleDto } from './example.dto.js';

export class UpdateExampleDto extends PartialType(CreateExampleDto) {}
