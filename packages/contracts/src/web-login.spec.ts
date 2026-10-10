import {describe,expect,it} from 'vitest';
import {webLoginRequestSchema} from './index.js';

const input={email:'first@example.org',password:'A-synthetic-strong-password-2026'};
describe('opt-in HTTPS web login request contract',()=>{
  it('only accepts bounded e-mail and secret and no principal overrides',()=>{
    expect(webLoginRequestSchema.parse(input)).toEqual(input);
    for(const bad of [
      {...input,userId:'1'}, {...input,admin:true},
      {...input,deviceLabel:'impersonate-other-device'},
      {...input,password:'short'}, {...input,password:'x'.repeat(129)},
      {...input,password:'Valid-Length-With-\0-Separator'},
      {...input,email:'not-an-email'},
    ]){
      expect(webLoginRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});
