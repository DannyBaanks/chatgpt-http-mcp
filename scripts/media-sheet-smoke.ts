import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const client=new Client({name:'sheet-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp/main.ts')],env:process.env as Record<string,string>,stderr:'pipe'});transport.stderr?.on('data',()=>{});
try{
 await client.connect(transport);const result:any=await client.callTool({name:'video_contact_sheet',arguments:{asset_id:process.argv[2],start_seconds:0,end_seconds:18,columns:4}});
 if(result.isError)throw Error(result.content[0].text);
 const jpg=Buffer.from(result.content[1].data,'base64');writeFileSync('/tmp/isymcp-angel-contact-sheet.jpg',jpg,{mode:0o600});
 console.log(JSON.stringify({metadata:JSON.parse(result.content[0].text),image:{mimeType:result.content[1].mimeType,bytes:jpg.length,path:'/tmp/isymcp-angel-contact-sheet.jpg'}},null,2));
}finally{await client.close();}
