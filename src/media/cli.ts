import { MediaCatalog } from './catalog';
export async function mediaCommand(command:string|undefined,args:string[]) {
 const catalog=new MediaCatalog();
 if(command==='add' && args.length===1) { const {id,name,bytes,sha256}=await catalog.add(args[0]); console.log(JSON.stringify({id,name,bytes,sha256},null,2)); }
 else if(command==='list' && !args.length) console.log(JSON.stringify(catalog.list(),null,2));
 else if(command==='revoke' && args.length===1) {catalog.revoke(args[0]); console.log('Asset revoked; original preserved.');}
 else throw Error('Usage: isymcp media add <file> | list | revoke <asset_id>');
}
