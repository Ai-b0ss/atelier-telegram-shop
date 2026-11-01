#!/usr/bin/env node
/**
 * Portable encrypted D1 backups: unlike the DPAPI script, they restore on any computer.
 *
 *   node scripts/d1-backup.mjs backup              export, verify, encrypt into backups/
 *   node scripts/d1-backup.mjs decrypt FILE OUT    decrypt one archive to a SQL file
 *   node scripts/d1-backup.mjs drill FILE          restore into a temporary separate D1, compare, delete it
 *
 * The passphrase comes from ATELIER_BACKUP_PASSPHRASE or ~/.atelier-secrets/backup-passphrase.txt,
 * which is generated on first use. Without it the archives cannot be opened: keep a copy elsewhere.
 * Only status markers are printed, never SQL or customer data.
 */
import {randomBytes,scryptSync,createCipheriv,createDecipheriv,createHash} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync,rmSync,mkdtempSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {homedir,tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const MAGIC=Buffer.from("ATLBK1\n");
const SCRYPT={N:2**16,r:8,p:1,maxmem:256*1024*1024};
const DATABASE="atelier-customwear-demo-2026";
const WRANGLER="wrangler@4.156.0";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

export function encryptBackup(plain,passphrase){
  const salt=randomBytes(16),iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",scryptSync(passphrase,salt,32,SCRYPT),iv);
  cipher.setAAD(MAGIC);
  const body=Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([MAGIC,salt,iv,cipher.getAuthTag(),body]);
}

export function decryptBackup(archive,passphrase){
  if(!archive.subarray(0,MAGIC.length).equals(MAGIC))throw new Error("Not an Atelier backup archive");
  let at=MAGIC.length;
  const take=n=>archive.subarray(at,at+=n);
  const salt=take(16),iv=take(12),tag=take(16);
  const decipher=createDecipheriv("aes-256-gcm",scryptSync(passphrase,salt,32,SCRYPT),iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(archive.subarray(at)),decipher.final()]);
}

function passphrase(){
  if(process.env.ATELIER_BACKUP_PASSPHRASE)return process.env.ATELIER_BACKUP_PASSPHRASE;
  const dir=path.join(homedir(),".atelier-secrets"),file=path.join(dir,"backup-passphrase.txt");
  if(!existsSync(file)){
    mkdirSync(dir,{recursive:true});
    writeFileSync(file,randomBytes(32).toString("base64url")+"\n",{mode:0o600});
    console.log("PASSPHRASE_CREATED="+file);
  }
  return readFileSync(file,"utf8").trim();
}

function wrangler(args,{capture=false}={}){
  const result=spawnSync("npx",["--yes",WRANGLER,...args],{cwd:path.join(root,"cloudflare"),shell:process.platform==="win32",encoding:"utf8",input:"n\n"});
  if(result.status!==0)throw new Error("Wrangler step failed: "+args.slice(0,2).join(" "));
  return capture?result.stdout:"";
}

function verifySql(file){
  const result=spawnSync("python",[path.join(root,"scripts","verify-d1-export.py"),file],{encoding:"utf8"});
  if(result.status!==0)throw new Error("SQL export failed verification");
}

function counts(database){
  const sql="SELECT (SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM order_items) i,(SELECT COUNT(*) FROM variants) v,(SELECT COUNT(*) FROM customers) c,(SELECT COUNT(*) FROM payments) p";
  const out=wrangler(["d1","execute",database,"--remote","--json","--command",JSON.stringify(sql)],{capture:true});
  return JSON.stringify(JSON.parse(out.slice(out.indexOf("[")))[0].results[0]);
}

function withTempSql(work){
  const dir=mkdtempSync(path.join(tmpdir(),"atelier-d1-"));
  try{return work(path.join(dir,"export.sql"))}
  finally{rmSync(dir,{recursive:true,force:true})}
}

function backup(){
  const secret=passphrase();
  const target=withTempSql(sqlFile=>{
    wrangler(["d1","export",DATABASE,"--remote","--output",sqlFile]);
    verifySql(sqlFile);
    const plain=readFileSync(sqlFile),archive=encryptBackup(plain,secret);
    if(!createHash("sha256").update(decryptBackup(archive,secret)).digest().equals(createHash("sha256").update(plain).digest()))
      throw new Error("Backup roundtrip mismatch");
    mkdirSync(path.join(root,"backups"),{recursive:true});
    const stamp=new Date().toISOString().replace(/[-:]/g,"").replace(/\..*/,"Z");
    const file=path.join(root,"backups","atelier-D1-"+stamp+".sql.atlbk");
    writeFileSync(file,archive);
    return file;
  });
  console.log("BACKUP_CREATED="+target);
  console.log("ROUNDTRIP_OK");
}

function drill(file){
  const name="atelier-restore-drill-"+Date.now();
  withTempSql(sqlFile=>{
    writeFileSync(sqlFile,decryptBackup(readFileSync(file),passphrase()));
    verifySql(sqlFile);
    wrangler(["d1","create",name]);
    try{
      wrangler(["d1","execute",name,"--remote","--yes","--file",sqlFile]);
      console.log("RESTORE_OK");
      const restored=counts(name),live=counts(DATABASE);
      console.log(restored===live?"COUNTS_MATCH_LIVE":"COUNTS_DIFFER_FROM_LIVE (expected if orders arrived after the backup)");
    }finally{
      wrangler(["d1","delete",name,"--skip-confirmation"]);
      console.log("DRILL_DATABASE_DELETED");
    }
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,a,b]=process.argv.slice(2);
  if(command==="backup")backup();
  else if(command==="decrypt"&&a&&b)writeFileSync(b,decryptBackup(readFileSync(a),passphrase()));
  else if(command==="drill"&&a)drill(a);
  else{console.error("Usage: d1-backup.mjs backup | decrypt FILE OUT | drill FILE");process.exit(2)}
}
