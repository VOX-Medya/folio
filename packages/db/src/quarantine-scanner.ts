import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

/**
 * Internal quarantine-only AV inspection. A clean AV result is NOT a
 * publishing grant, format-validation result, DB status transition or proof
 * of legal access. No HTTP route or worker schedules this by default.
 */
export type QuarantineScanVerdict='clean'|'infected';
export interface QuarantineByteScanner {
  scan(source:AsyncIterable<Uint8Array>):Promise<QuarantineScanVerdict>;
}

/** Early V1 scanner capacity, independent of the 1 GiB staging maximum.
 * Files above 16 MiB remain quarantined pending a separately tested
 * streaming scanner configuration. Never silently call a file clean when
 * ClamAV's size/decompression/time limit was exceeded. */
export const PRIVATE_CLAMAV_MAX_BYTES=16*1024*1024;
const CLAMAV_SCAN_TIMEOUT_MS=180_000;
const MAX_DIAGNOSTIC_BYTES=4096;

/** clamscan(1): stdin '-' with fresh signature DB, no path handoff,
 * no shell, no delete/move, encrypted/limit events fail the scan.
 * Unknown options or absent/outdated signatures cause nonzero exit and
 * therefore FAIL CLOSED. The base Folio image has no ClamAV/signatures,
 * so the production default is unavailable until explicitly provisioned.
 */
export const PRIVATE_CLAMAV_ARGS=Object.freeze([
  '--no-summary',
  '--stdout',
  '--fail-if-cvd-older-than=3',
  '--alert-exceeds-max=yes',
  '--alert-encrypted=yes',
  '--max-filesize=16M',
  '--max-scansize=64M',
  '--max-files=4096',
  '--max-recursion=12',
  '--max-scantime=120000',
  '-',
] as const);

/**
 * Internal POSIX subprocess adapter. The default uses an absolute executable
 * path and fixed arguments. Custom command/args exist ONLY for hermetic
 * injected-process CI tests; do NOT supply these from env, API or users.
 */
export class ClamAvStdinScanner implements QuarantineByteScanner {
  constructor(
    private readonly executable='/usr/bin/clamscan',
    private readonly args:readonly string[]=PRIVATE_CLAMAV_ARGS,
    private readonly timeoutMs=CLAMAV_SCAN_TIMEOUT_MS,
  ){
    if(!executable.startsWith('/')||!Number.isSafeInteger(timeoutMs)||
      timeoutMs<50||timeoutMs>CLAMAV_SCAN_TIMEOUT_MS){
      throw new Error('Unsafe ClamAV scanner subprocess configuration');
    }
  }

  async scan(source:AsyncIterable<Uint8Array>):Promise<QuarantineScanVerdict>{
    const child=spawn(this.executable,[...this.args],{
      shell:false,
      stdio:['pipe','pipe','pipe'],
      windowsHide:true,
      cwd:'/',
      env:{PATH:'/usr/bin:/bin',LANG:'C'},
    });
    let stdout='',stderr='',outputOverflow=false,timedOut=false,spawnFailed=false;
    const capture=(target:'stdout'|'stderr',data:Buffer)=>{
      if(target==='stdout'){
        if(Buffer.byteLength(stdout)+data.length>MAX_DIAGNOSTIC_BYTES)outputOverflow=true;
        else stdout+=data.toString('utf8');
      }else{
        if(Buffer.byteLength(stderr)+data.length>MAX_DIAGNOSTIC_BYTES)outputOverflow=true;
        else stderr+=data.toString('utf8');
      }
      if(outputOverflow)child.kill('SIGKILL');
    };
    child.stdout.on('data',(chunk:Buffer)=>capture('stdout',chunk));
    child.stderr.on('data',(chunk:Buffer)=>capture('stderr',chunk));
    const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
      child.on('error',()=>{spawnFailed=true;});
      child.on('close',(code,signal)=>resolve({code,signal}));
    });
    const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},this.timeoutMs);
    // Node stream pipeline honors backpressure. Never buffers a whole book
    // and never passes any private pathname or storage ID to clamscan.
    let complete=false;
    try{
      const pumping=pipeline(Readable.from(source),child.stdin)
        .then(()=>{complete=true;},()=>{complete=false;});
      const [termination]=await Promise.all([exit,pumping]);
      if(timedOut||spawnFailed||outputOverflow||!complete||termination.signal!==null||
        stderr.trim().length>0)throw new Error('Private malware scan unavailable or incomplete');
      if(termination.code===0&&stdout.trim()==='stdin: OK')return 'clean';
      if(termination.code===1&&/^stdin: [^\r\n]{1,256} FOUND$/.test(stdout.trim())){
        return 'infected';
      }
      throw new Error('Private malware scan unavailable or incomplete');
    }finally{
      clearTimeout(timeout);
      if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');
    }
  }
}
