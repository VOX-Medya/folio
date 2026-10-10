#!/usr/bin/env node
import {constants,copyFileSync,cpSync,existsSync,lstatSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validatePreparedFolder} from '../src/manifest.mjs';
import {validatePreparedArchive} from '../src/archive.mjs';

function option(args,name){const i=args.indexOf(`--${name}`);return i>=0?args[i+1]:undefined;}
async function main(){
  const [command,subcommand,...args]=process.argv.slice(2);
  if(command==='import'){
    if(!args.includes('--dry-run')||args.includes('--apply'))throw new Error('Only import --dry-run is enabled; apply/resume require a trusted backend actor and asset staging');
    const input=subcommand;
    if(!input||input.startsWith('--'))throw new Error('Usage: folioctl import FILE.tar.zst --dry-run [--report REPORT.json]');
    const url=process.env.DATABASE_URL;
    if(!url)throw new Error('Explicit Folio loopback DATABASE_URL required for dry-run');
    const database=new URL(url);
    if(!['127.0.0.1','localhost'].includes(database.hostname)||database.port!==(process.env.FOLIO_DB_PORT??'55432')||
      !['/folio_test','/folio_lab'].includes(database.pathname))throw new Error('Import preview is restricted to the explicit local Folio DB');
    const validated=input.endsWith('.tar.zst')?await validatePreparedArchive(input):await validatePreparedFolder(input);
    const {createFolioDb,previewPreparedCatalogImport}=await import('@folio/db');
    const {db,pool}=createFolioDb(url);
    try{
      const planned=await previewPreparedCatalogImport(db,{
        packageId:validated.manifest.package_id,manifestChecksum:createHash('sha256').update(validated.checksums).digest('hex'),
        schemaVersion:validated.manifest.schema_version,records:validated.semantic.records,
      });
      const report=option(args,'report');
      const text=JSON.stringify({...planned,readOnly:true,noPublicWrites:true},null,2)+'\n';
      if(report)writeFileSync(resolve(report),text,{flag:'wx'});
      else process.stdout.write(text);
    }finally{await pool.end();}
    return;
  }
  if(command!=='pack')throw new Error('Only pack and read-only import preview are enabled; export requires rights-aware backend');
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
