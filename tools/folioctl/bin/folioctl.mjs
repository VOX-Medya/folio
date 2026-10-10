#!/usr/bin/env node
import {constants,copyFileSync,cpSync,existsSync,lstatSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validatePreparedFolder} from '../src/manifest.mjs';
import {validatePreparedArchive} from '../src/archive.mjs';

function option(args,name){const i=args.indexOf(`--${name}`);return i>=0?args[i+1]:undefined;}
async function main(){
  const [command,subcommand,...args]=process.argv.slice(2);
  if(command!=='pack')throw new Error('Only offline pack validate/build is enabled; import/export require rights-aware backend #19/#23');
  if(!['validate','build'].includes(subcommand))throw new Error('Usage: folioctl pack {validate|build} --input DIR [--out FILE.tar.zst]');
  const input=option(args,'input');
  if(!input)throw new Error('Required: --input prepared folder');
  const isArchive=input.endsWith('.tar.zst');
  if(isArchive&&subcommand!=='validate')throw new Error('Cannot build from an archive; use a prepared directory');
  const result=isArchive?await validatePreparedArchive(input):await validatePreparedFolder(input);
  if(subcommand==='validate'){
    process.stdout.write(JSON.stringify({valid:true,package_id:result.manifest.package_id,count:result.count,totalBytes:result.totalBytes})+'\n');
    return;
  }
  const out=option(args,'out');
  if(!out||!out.endsWith('.tar.zst'))throw new Error('Required: --out FILE.tar.zst');
  const output=resolve(out);
  try{lstatSync(output);throw new Error('Refusing to overwrite existing archive or symlink');}catch(error){if(error.code!=='ENOENT')throw error;}
  const folder=mkdtempSync(join(tmpdir(),'folio-pack-'));
  const outputStaging=mkdtempSync(join(tmpdir(),'folio-archive-'));
  const temporaryOutput=join(outputStaging,'output.tar.zst');
  try{
    cpSync(resolve(input),folder,{recursive:true,errorOnExist:false,force:false});
    if(!existsSync(join(folder,'sha256sums.txt')))writeFileSync(join(folder,'sha256sums.txt'),result.checksums,{flag:'wx'});
    const copied=await validatePreparedFolder(folder);
    if(copied.checksums!==result.checksums)throw new Error('Input changed during package preparation');
    mkdirSync(dirname(output),{recursive:true});
    const args=['--create','--zstd','--file',temporaryOutput,'--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--format=posix','--pax-option=delete=atime,delete=ctime','-C',folder,'.'];
    const run=spawnSync('tar',args,{encoding:'utf8',maxBuffer:1024*1024});
    if(run.error||run.status!==0)throw new Error(`Archive build failed: ${run.error?.message??run.stderr.slice(0,600)}`);
    copyFileSync(temporaryOutput,output,constants.COPYFILE_EXCL);
    process.stdout.write(JSON.stringify({built:true,out:output,package_id:result.manifest.package_id})+'\n');
  }finally{rmSync(folder,{recursive:true,force:true});rmSync(outputStaging,{recursive:true,force:true});}
}
main().catch(err=>{console.error(`folioctl: ${err.message}`);process.exitCode=1;});
