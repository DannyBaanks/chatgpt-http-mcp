import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MediaService } from '../media/service';
const server=new Server({name:'isymcp-media',version:'1.0.0'},{capabilities:{tools:{}}});
const service=new MediaService();
const id={type:'string',description:'Opaque ID from isymcp media add; never a filesystem path'};
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
 {name:'media_info',description:'Inspect a locally registered audio/video file. Processing runs on the user computer.',inputSchema:{type:'object',properties:{asset_id:id},required:['asset_id'],additionalProperties:false}},
 {name:'audio_analyze',description:'Return local RMS, peaks, silence intervals, waveform and spectrogram for up to 60 seconds. Images are acoustic evidence, not native listening.',inputSchema:{type:'object',properties:{asset_id:id,start_seconds:{type:'number',minimum:0},end_seconds:{type:'number',minimum:0}},required:['asset_id','start_seconds','end_seconds'],additionalProperties:false}},
 {name:'video_frame',description:'Return one real frame from a registered local video through Video Vision. Request timestamps individually.',inputSchema:{type:'object',properties:{asset_id:id,timestamp_seconds:{type:'number',minimum:0}},required:['asset_id','timestamp_seconds'],additionalProperties:false}}
]}));
server.setRequestHandler(CallToolRequestSchema,async request=>service.call(request.params.name,request.params.arguments||{}));
await server.connect(new StdioServerTransport());
