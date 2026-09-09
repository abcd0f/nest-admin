import { Injectable } from '@nestjs/common';

import { aaa } from '@w/common';

@Injectable()
export class AppService {
  getHello(): string {
    console.log(aaa);
    return 'Hello World!';
  }
}
