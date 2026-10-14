import { openSync, closeSync, readFileSync, appendFileSync, writeFileSync, lstatSync, unlinkSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { OwnerRef } from './contracts';
export type ConversationEvent =
 | {kind:'user';messageId:string;text:string}
 | {kind:'assistant';messageId:string;markdown:string;complete:boolean}
 | {kind:'progress';messageId:string;text:string}
 | {kind:'tool';callId:string;wireName:string;input:unknown}
 | {kind:'result';callId:string;output:unknown}
 | {kind:'closed';reason:string};
export interface ConversationEntry {sequence:number;at:string;owner:OwnerRef;event:ConversationEvent}
const identity = (owner:OwnerRef) => JSON.stringify([owner.launchId,owner.threadId,owner.turnId,owner.epoch]);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class ConversationJournal {
 private entries:ConversationEntry[]=[];
 private bytes=0;
 constructor(private path:string,private owner:OwnerRef){
  if(!isAbsolute(path)||Object.values(owner).length!==4||!Object.values(owner).every(x=>uuid.test(x)))throw Error('journal_owner_invalid');
  const parent=lstatSync(dirname(path));
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw Error('journal_parent_not_private');
  try {writeFileSync(path,JSON.stringify({version:'isymcp-conversation-journal/1',owner})+'\n',{flag:'wx',mode:0o600});}
  catch(e:any){if(e.code!=='EEXIST')throw e;}
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('journal_not_private');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let text:string;try{text=readFileSync(fd,'utf8');}finally{closeSync(fd);}
  if(!text.endsWith('\n'))throw Error('journal_corrupt_tail_preserved');
  const lines=text.trimEnd().split('\n');let header:any;
  try{header=JSON.parse(lines.shift()!);}catch{throw Error('journal_corrupt_header');}
  if(header.version!=='isymcp-conversation-journal/1'||identity(header.owner)!==identity(owner))throw Error('journal_owner_mismatch');
  try{this.entries=lines.map((line,i)=>{const row=JSON.parse(line);if(row.sequence!==i+1||identity(row.owner)!==identity(owner)||!row.event||!row.at)throw Error();return row;});}
  catch{throw Error('journal_corrupt_records_preserved');}
  this.bytes=Buffer.byteLength(text);
 }
 async append(event:ConversationEvent):Promise<ConversationEntry>{
  const lock=this.path+'.lock';let fd:number;
  try{fd=openSync(lock,'wx',0o600);}catch{throw Error('journal_writer_conflict');}
  try{
   const stat=lstatSync(this.path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.size!==this.bytes)throw Error('journal_writer_changed');
   const entry:ConversationEntry={sequence:this.entries.length+1,at:new Date().toISOString(),owner:this.owner,event:structuredClone(event)};
   const line=JSON.stringify(entry)+'\n';const out=openSync(this.path,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);
   try{appendFileSync(out,line);}finally{closeSync(out);}
   this.bytes+=Buffer.byteLength(line);this.entries.push(entry);return structuredClone(entry);
  }finally{closeSync(fd);unlinkSync(lock);}
 }
 readAfter(sequence:number):ConversationEntry[]{
  if(!Number.isInteger(sequence)||sequence<0)throw Error('journal_cursor_invalid');
  return structuredClone(this.entries.filter(e=>e.sequence>sequence));
 }
}
