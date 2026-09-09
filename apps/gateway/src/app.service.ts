import { Injectable } from '@nestjs/common';

import { aaa } from '../../../packages/common/src/index.js';

@Injectable()
export class AppService {
  getHello(): string {
    console.log(aaa);
    return 'Hello World!';
  }
}
